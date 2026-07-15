$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "llama-device.ps1")

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$settings = Get-Content -LiteralPath (Join-Path $root ".cli\settings.json") -Raw | ConvertFrom-Json
$llamaDirectory = if ($env:LLAMA_CPP_DIR) { $env:LLAMA_CPP_DIR } else { $settings.llamaCppPath }
$modelDirectory = if ($env:LLAMA_MODEL_DIR) { $env:LLAMA_MODEL_DIR } else { $settings.modelPath }
$modelName = if ($env:LLAMA_MODEL) { $env:LLAMA_MODEL } else { $settings.defaultModel }
$bench = Join-Path $llamaDirectory "llama-bench.exe"
$server = Join-Path $llamaDirectory "llama-server.exe"
$model = Join-Path $modelDirectory $modelName
if (-not (Test-Path -LiteralPath $bench -PathType Leaf)) { throw "llama-bench executable not found: $bench" }
if (-not (Test-Path -LiteralPath $model -PathType Leaf)) { throw "Model not found: $model" }

$requested = if ($env:LLAMA_DEVICE) { $env:LLAMA_DEVICE } elseif ($settings.device) { $settings.device } else { "auto" }
$device = Resolve-LlamaDevice -ServerExecutable $server -RequestedDevice $requested
$profile = Get-LlamaRuntimeProfile -Device $device
$logDirectory = Join-Path $root ".cli\logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDirectory "hardware-benchmark-$stamp.txt"

Write-Host "Opt-in benchmark: $($profile.Backend) / $device"
Write-Host "Model: $modelName"
Write-Host "This runs prompt 512 and generation 128 twice."
$arguments = @("-m", $model, "-p", "512", "-n", "128", "-r", "2", "-b", $profile.BatchSize.ToString(), "-ub", $profile.UBatchSize.ToString())
if ($device) { $arguments += @("--device", $device, "-ngl", "all") }
& $bench @arguments 2>&1 | Tee-Object -FilePath $logPath
if ($LASTEXITCODE -ne 0) { throw "llama-bench failed with exit code $LASTEXITCODE" }
Write-Host "Benchmark log: $logPath"
