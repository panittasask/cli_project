$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "llama-device.ps1")
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $appRoot

function Get-CliSettings {
    $settingsPath = Join-Path $PSScriptRoot "..\.cli\settings.json"
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
        return [pscustomobject]@{}
    }

    return Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
}

$settings = Get-CliSettings
$llamaDirectory = if ($env:LLAMA_CPP_DIR) { $env:LLAMA_CPP_DIR } elseif ($settings.llamaCppPath) { $settings.llamaCppPath } else { "D:\llama.cpp\llama-b10012-bin-win-sycl-x64" }
$modelDirectory = if ($env:LLAMA_MODEL_DIR) { $env:LLAMA_MODEL_DIR } elseif ($settings.modelPath) { $settings.modelPath } else { "D:\Model" }
$requestedLlamaDevice = if ($env:LLAMA_DEVICE) { $env:LLAMA_DEVICE } elseif ($settings.device) { $settings.device } else { "auto" }
$contextLength = if ($env:LLAMA_CONTEXT_LENGTH) { $env:LLAMA_CONTEXT_LENGTH } elseif ($settings.contextLength) { $settings.contextLength } else { 65536 }
$parsedContextLength = 0
if (-not [int]::TryParse($contextLength.ToString(), [ref]$parsedContextLength) -or $parsedContextLength -lt 512) {
    throw "Invalid context length: $contextLength"
}

$launcher = Join-Path $llamaDirectory "llama-server.exe"

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "llama-server executable not found: $launcher"
}

$llamaDevice = Resolve-LlamaDevice -ServerExecutable $launcher -RequestedDevice $requestedLlamaDevice
$runtimeProfile = Get-LlamaRuntimeProfile -Device $llamaDevice

$models = @(Get-ChildItem -LiteralPath $modelDirectory -File -Filter "*.gguf" | Sort-Object Name)
if ($models.Count -eq 0) {
    throw "No .gguf models found in: $modelDirectory"
}

$defaultModelName = if ($env:LLAMA_MODEL) { $env:LLAMA_MODEL } elseif ($settings.defaultModel) { $settings.defaultModel } else { "" }
$defaultModelIndex = 0
for ($index = 0; $index -lt $models.Count; $index += 1) {
    if ($models[$index].Name -ieq $defaultModelName) {
        $defaultModelIndex = $index
        break
    }
}

Write-Host "Available models"
Write-Host "================"
Write-Host ("Context length: {0:N0} tokens" -f $parsedContextLength)
for ($index = 0; $index -lt $models.Count; $index += 1) {
    $sizeGb = [Math]::Round($models[$index].Length / 1GB, 2)
    $marker = if ($index -eq $defaultModelIndex) { " *" } else { "" }
    Write-Host ("[{0}] {1} ({2} GB){3}" -f ($index + 1), $models[$index].Name, $sizeGb, $marker)
}

$defaultNumber = $defaultModelIndex + 1
$choice = Read-Host "Select model [1-$($models.Count)] (default $defaultNumber)"
if ([string]::IsNullOrWhiteSpace($choice)) {
    $choice = $defaultNumber.ToString()
}

$selectedNumber = 0
if (-not [int]::TryParse($choice, [ref]$selectedNumber) -or $selectedNumber -lt 1 -or $selectedNumber -gt $models.Count) {
    throw "Invalid model selection: $choice"
}

$selectedModel = $models[$selectedNumber - 1]
$serverArguments = @("-m", $selectedModel.FullName, "-c", $parsedContextLength.ToString(), "-b", $runtimeProfile.BatchSize.ToString(), "-ub", $runtimeProfile.UBatchSize.ToString(), "-np", "1", "-fa", "auto", "--host", "127.0.0.1", "--port", "8080")
if (-not [string]::IsNullOrWhiteSpace($llamaDevice)) {
    $serverArguments += @("--device", $llamaDevice, "-ngl", "all")
}

Write-Host "Starting llama.cpp from: $llamaDirectory"
Write-Host "Model: $($selectedModel.Name)"
Write-Host "Device: $(if ($llamaDevice) { $llamaDevice } else { 'auto' })"
Write-Host "Runtime profile: $($runtimeProfile.Backend), batch $($runtimeProfile.BatchSize), ubatch $($runtimeProfile.UBatchSize)"
Write-Host ("Configured context: {0:N0} tokens" -f $parsedContextLength)
Write-Host "The CLI will connect to: http://127.0.0.1:8080"
Write-Host ""

& $launcher @serverArguments
