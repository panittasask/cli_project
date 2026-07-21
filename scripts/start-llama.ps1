$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "llama-device.ps1")
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $appRoot

function Get-CliSettings {
    $settingsPath = Join-Path $PSScriptRoot "..\.cli\settings.json"
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
        $settingsPath = Join-Path $PSScriptRoot "..\.cli\settings.example.json"
    }
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
        return [pscustomobject]@{}
    }

    return Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
}

$settings = Get-CliSettings
$llamaDirectory = if ($env:LLAMA_CPP_DIR) { $env:LLAMA_CPP_DIR } elseif ($settings.llamaCppPath) { $settings.llamaCppPath } else { "D:\llama.cpp\llama-b10012-bin-win-sycl-x64" }
$modelDirectory = if ($env:LLAMA_MODEL_DIR) { $env:LLAMA_MODEL_DIR } elseif ($settings.modelPath) { $settings.modelPath } else { "D:\Model" }
$requestedLlamaDevice = if ($env:LLAMA_DEVICE) { $env:LLAMA_DEVICE } elseif ($settings.device) { $settings.device } else { "auto" }
$requestedHardwareProfile = if ($env:LLAMA_HARDWARE_PROFILE) { $env:LLAMA_HARDWARE_PROFILE } elseif ($settings.hardwareProfile) { $settings.hardwareProfile } else { "auto" }
$contextLength = if ($env:LLAMA_CONTEXT_LENGTH) { $env:LLAMA_CONTEXT_LENGTH } elseif ($settings.contextLength) { $settings.contextLength } else { 16384 }
$serverHost = if ($env:LLAMA_ARG_HOST) { $env:LLAMA_ARG_HOST } elseif ($settings.serverHost) { $settings.serverHost } else { "127.0.0.1" }
$serverPort = if ($env:LLAMA_ARG_PORT) { $env:LLAMA_ARG_PORT } elseif ($settings.serverPort) { $settings.serverPort } else { 8080 }
$routerMode = if ($env:LLAMA_ROUTER_MODE) { $env:LLAMA_ROUTER_MODE -match '^(?i:1|true|on|yes)$' } elseif ($null -ne $settings.routerMode) { [bool]$settings.routerMode } else { $false }
$modelsMax = if ($env:LLAMA_MODELS_MAX) { $env:LLAMA_MODELS_MAX } elseif ($settings.modelsMax) { $settings.modelsMax } else { 1 }
$parsedContextLength = 0
if (-not [int]::TryParse($contextLength.ToString(), [ref]$parsedContextLength) -or $parsedContextLength -lt 512) {
    throw "Invalid context length: $contextLength"
}
$parsedServerPort = 0
if (-not [int]::TryParse($serverPort.ToString(), [ref]$parsedServerPort) -or $parsedServerPort -lt 1 -or $parsedServerPort -gt 65535) {
    throw "Invalid llama.cpp server port: $serverPort"
}
$parsedModelsMax = 0
if (-not [int]::TryParse($modelsMax.ToString(), [ref]$parsedModelsMax) -or $parsedModelsMax -lt 1 -or $parsedModelsMax -gt 32) {
    throw "Invalid maximum loaded models: $modelsMax"
}

$launcher = Join-Path $llamaDirectory "llama-server.exe"

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "llama-server executable not found: $launcher"
}

$llamaDevice = Resolve-LlamaDevice -ServerExecutable $launcher -RequestedDevice $requestedLlamaDevice
$llamaDeviceDescription = Get-LlamaDeviceDescription -ServerExecutable $launcher -Device $llamaDevice
$runtimeProfile = Get-LlamaRuntimeProfile -Device $llamaDevice -HardwareProfile $requestedHardwareProfile -DeviceDescription $llamaDeviceDescription
$memoryProfile = Get-LlamaMemoryProfile -Device $llamaDevice -HardwareProfile $runtimeProfile.Name -DeviceDescription $llamaDeviceDescription

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

$selectedModel = $null
$serverArguments = @("-c", $parsedContextLength.ToString(), "-b", $runtimeProfile.BatchSize.ToString(), "-ub", $runtimeProfile.UBatchSize.ToString(), "-np", "1", "-fa", "auto", "--host", $serverHost, "--port", $parsedServerPort.ToString())
if ($routerMode) {
    $serverArguments += @("--models-dir", $modelDirectory, "--models-max", $parsedModelsMax.ToString())
    $speculativeProfile = [pscustomobject]@{ Arguments = @(); Description = "off (router mode; configure per-model presets for MTP)" }
} else {
    $defaultNumber = $defaultModelIndex + 1
    $choice = Read-Host "Select model [1-$($models.Count)] (default $defaultNumber)"
    if ([string]::IsNullOrWhiteSpace($choice)) { $choice = $defaultNumber.ToString() }
    $selectedNumber = 0
    if (-not [int]::TryParse($choice, [ref]$selectedNumber) -or $selectedNumber -lt 1 -or $selectedNumber -gt $models.Count) {
        throw "Invalid model selection: $choice"
    }
    $selectedModel = $models[$selectedNumber - 1]
    $speculativeProfile = Get-LlamaSpeculativeProfile -ServerExecutable $launcher -ModelPath $selectedModel.FullName
    $serverArguments = @("-m", $selectedModel.FullName) + $serverArguments
}
$serverArguments += @($memoryProfile.Arguments)
$serverArguments += @($speculativeProfile.Arguments)

Write-Host "Starting llama.cpp from: $llamaDirectory"
Write-Host $(if ($routerMode) { "Model router: $modelDirectory (max loaded: $parsedModelsMax)" } else { "Model: $($selectedModel.Name)" })
Write-Host "Device: $(if ($llamaDevice) { "$llamaDevice $llamaDeviceDescription" } else { 'auto' })"
Write-Host "Runtime profile: $($runtimeProfile.Name) / $($runtimeProfile.Backend), batch $($runtimeProfile.BatchSize), ubatch $($runtimeProfile.UBatchSize)"
Write-Host "Memory profile: $($memoryProfile.Description)"
Write-Host "Speculative decoding: $($speculativeProfile.Description)"
Write-Host ("Configured context: {0:N0} tokens" -f $parsedContextLength)
Write-Host "Listening on: http://${serverHost}:$parsedServerPort"
Write-Host "Local health check: http://127.0.0.1:$parsedServerPort/health"
Write-Host ""

& $launcher @serverArguments
