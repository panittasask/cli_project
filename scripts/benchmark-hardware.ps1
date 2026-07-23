$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "llama-device.ps1")

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$settingsPath = Join-Path $root ".cli\settings.json"
if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
    $settingsPath = Join-Path $root ".cli\settings.example.json"
}
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$llamaDirectory = if ($env:LLAMA_CPP_DIR) { $env:LLAMA_CPP_DIR } else { $settings.llamaCppPath }
$modelDirectory = if ($env:LLAMA_MODEL_DIR) { $env:LLAMA_MODEL_DIR } else { $settings.modelPath }
$modelName = if ($env:LLAMA_MODEL) { $env:LLAMA_MODEL } else { $settings.defaultModel }
$bench = Join-Path $llamaDirectory "llama-bench.exe"
$server = Join-Path $llamaDirectory "llama-server.exe"
$model = Join-Path $modelDirectory $modelName
if (-not (Test-Path -LiteralPath $bench -PathType Leaf)) { throw "llama-bench executable not found: $bench" }
if (-not (Test-Path -LiteralPath $model -PathType Leaf)) { throw "Model not found: $model" }

$requested = if ($env:LLAMA_DEVICE) { $env:LLAMA_DEVICE } elseif ($settings.device) { $settings.device } else { "auto" }
$requestedProfile = if ($env:LLAMA_HARDWARE_PROFILE) { $env:LLAMA_HARDWARE_PROFILE } elseif ($settings.hardwareProfile) { $settings.hardwareProfile } else { "auto" }
$device = Resolve-LlamaDevice -ServerExecutable $server -RequestedDevice $requested
$deviceDescription = Get-LlamaDeviceDescription -ServerExecutable $server -Device $device
$profile = Get-LlamaRuntimeProfile -Device $device -HardwareProfile $requestedProfile -DeviceDescription $deviceDescription
$memory = Get-LlamaMemoryProfile -Device $device -HardwareProfile $profile.Name -DeviceDescription $deviceDescription
$logDirectory = Join-Path $root ".cli\logs\benchmark"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDirectory "hardware-benchmark-$stamp.txt"

Write-Host "Opt-in benchmark: $($profile.Name) / $($profile.Backend) / $device $deviceDescription"
Write-Host "Model: $modelName"
Write-Host "This runs prompt 512 and generation 128 twice."
$arguments = @("-m", $model, "-p", "512", "-n", "128", "-r", "2", "-b", $profile.BatchSize.ToString(), "-ub", $profile.UBatchSize.ToString())
if ($device) { $arguments += @("--device", $device) }
if ($memory.CacheType -ne "f16") { $arguments += @("-ctk", $memory.CacheType, "-ctv", $memory.CacheType) }
$previousErrorActionPreference = $ErrorActionPreference
try {
    # llama-bench writes normal backend and result output to stderr. PowerShell
    # 5 surfaces native stderr as ErrorRecord objects when the global policy is
    # Stop, so rely on the native exit code instead.
    $ErrorActionPreference = "Continue"
    & $bench @arguments 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -FilePath $logPath
    $benchmarkExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
if ($benchmarkExitCode -ne 0) { throw "llama-bench failed with exit code $benchmarkExitCode" }
Write-Host "Benchmark log: $logPath"
