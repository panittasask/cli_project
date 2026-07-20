param(
    [Parameter(Mandatory = $true)]
    [string]$ModelName,

    [Parameter(Mandatory = $true)]
    [int]$Port
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "llama-device.ps1")
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Get-CliSettings {
    $settingsPath = Join-Path $appRoot ".cli\settings.json"
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
        $settingsPath = Join-Path $appRoot ".cli\settings.example.json"
    }
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
        return [pscustomobject]@{}
    }
    return Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
}

$settings = Get-CliSettings
$llamaDirectory = if ($env:LLAMA_CPP_DIR) { $env:LLAMA_CPP_DIR } elseif ($settings.llamaCppPath) { $settings.llamaCppPath } else { "D:\llama.cpp\llama-b10012-bin-win-sycl-x64" }
$modelDirectory = if ($env:LLAMA_MODEL_DIR) { $env:LLAMA_MODEL_DIR } elseif ($settings.modelPath) { $settings.modelPath } else { "D:\Model" }
$requestedDevice = if ($env:LLAMA_DEVICE) { $env:LLAMA_DEVICE } elseif ($settings.device) { $settings.device } else { "auto" }
$requestedHardwareProfile = if ($env:LLAMA_HARDWARE_PROFILE) { $env:LLAMA_HARDWARE_PROFILE } elseif ($settings.hardwareProfile) { $settings.hardwareProfile } else { "auto" }
$contextLength = if ($env:LLAMA_CONTEXT_LENGTH) { [int]$env:LLAMA_CONTEXT_LENGTH } elseif ($settings.contextLength) { [int]$settings.contextLength } else { 16384 }
$launcher = Join-Path $llamaDirectory "llama-server.exe"
$modelPath = Join-Path $modelDirectory $ModelName

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "llama-server executable not found: $launcher" }
if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) { throw "Model not found: $modelPath" }
if ($contextLength -lt 512) { throw "Invalid context length: $contextLength" }
if ($Port -lt 1 -or $Port -gt 65535) { throw "Invalid port: $Port" }

$device = Resolve-LlamaDevice -ServerExecutable $launcher -RequestedDevice $requestedDevice
$deviceDescription = Get-LlamaDeviceDescription -ServerExecutable $launcher -Device $device
$runtimeProfile = Get-LlamaRuntimeProfile -Device $device -HardwareProfile $requestedHardwareProfile -DeviceDescription $deviceDescription
$memoryProfile = Get-LlamaMemoryProfile -Device $device -HardwareProfile $runtimeProfile.Name -DeviceDescription $deviceDescription
$speculativeProfile = Get-LlamaSpeculativeProfile -ServerExecutable $launcher -ModelPath $modelPath
$serverArguments = @(
    "-m", $modelPath, "-c", $contextLength.ToString(),
    "-b", $runtimeProfile.BatchSize.ToString(), "-ub", $runtimeProfile.UBatchSize.ToString(),
    "-np", "1", "-fa", "auto", "--host", "127.0.0.1", "--port", $Port.ToString()
)
$serverArguments += @($memoryProfile.Arguments)
$serverArguments += @($speculativeProfile.Arguments)

Write-Host "Model: $ModelName"
Write-Host "Device: $(if ($device) { "$device $deviceDescription" } else { 'auto' })"
Write-Host "Runtime: $($runtimeProfile.Name), batch $($runtimeProfile.BatchSize), ubatch $($runtimeProfile.UBatchSize), context $contextLength"
Write-Host "Memory: $($memoryProfile.Description)"
Write-Host "Speculative decoding: $($speculativeProfile.Description)"

& $launcher @serverArguments
exit $LASTEXITCODE
