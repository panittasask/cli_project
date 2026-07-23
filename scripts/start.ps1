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

$serverExecutable = Join-Path $llamaDirectory "llama-server.exe"
$logDirectory = Join-Path $PSScriptRoot "..\.cli\logs\server"
$stdoutLog = Join-Path $logDirectory "llama-server.log"
$stderrLog = Join-Path $logDirectory "llama-server-error.log"
$healthUrl = "http://127.0.0.1:$parsedServerPort/health"

$portCheck = [System.Net.Sockets.TcpClient]::new()
$portInUse = $false
try {
    $connectTask = $portCheck.ConnectAsync("127.0.0.1", $parsedServerPort)
    try {
        $portInUse = $connectTask.Wait(500) -and $portCheck.Connected
    } catch {
        $portInUse = $false
    }
} finally {
    $portCheck.Dispose()
}

$serverProcess = $null
$serverWasReused = $false

if ($portInUse) {
    $listener = Get-NetTCPConnection -LocalPort $parsedServerPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $runningProcess = if ($listener) { Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue } else { $null }
    if (-not $runningProcess -or $runningProcess.ProcessName -ne "llama-server") {
        $owner = if ($runningProcess) { "$($runningProcess.ProcessName) (PID $($runningProcess.Id))" } else { "an unknown process" }
        throw "Port $parsedServerPort is already used by $owner, not llama-server. Stop that process or configure another port."
    }

    $serverProcess = $runningProcess
    $serverWasReused = $true
    Write-Host "Reusing llama-server already listening on port $parsedServerPort (PID $($serverProcess.Id))."
} else {
    if (-not (Test-Path -LiteralPath $serverExecutable -PathType Leaf)) {
        throw "llama-server.exe not found: $serverExecutable"
    }
    if (-not (Test-Path -LiteralPath $modelDirectory -PathType Container)) {
        throw "Model directory not found: $modelDirectory"
    }

    $llamaDevice = Resolve-LlamaDevice -ServerExecutable $serverExecutable -RequestedDevice $requestedLlamaDevice
    $llamaDeviceDescription = Get-LlamaDeviceDescription -ServerExecutable $serverExecutable -Device $llamaDevice
    $runtimeProfile = Get-LlamaRuntimeProfile -Device $llamaDevice -HardwareProfile $requestedHardwareProfile -DeviceDescription $llamaDeviceDescription
    $memoryProfile = Get-LlamaMemoryProfile -Device $llamaDevice -HardwareProfile $runtimeProfile.Name -DeviceDescription $llamaDeviceDescription
    $models = @(Get-ChildItem -LiteralPath $modelDirectory -File -Filter "*.gguf" | Sort-Object Name)
    if ($models.Count -eq 0) { throw "No .gguf models found in: $modelDirectory" }

    $defaultModelName = if ($env:LLAMA_MODEL) { $env:LLAMA_MODEL } elseif ($settings.defaultModel) { $settings.defaultModel } else { "" }
    $defaultModelIndex = 0
    for ($index = 0; $index -lt $models.Count; $index += 1) {
        if ($models[$index].Name -ieq $defaultModelName) { $defaultModelIndex = $index; break }
    }

    Write-Host ""
    Write-Host "Available models"
    Write-Host "================"
    Write-Host ("Context length: {0:N0} tokens" -f $parsedContextLength)
    for ($index = 0; $index -lt $models.Count; $index += 1) {
        $sizeGb = [Math]::Round($models[$index].Length / 1GB, 2)
        $marker = if ($index -eq $defaultModelIndex) { " *" } else { "" }
        Write-Host ("[{0}] {1} ({2} GB){3}" -f ($index + 1), $models[$index].Name, $sizeGb, $marker)
    }

    $selectedModel = $null
    if ($routerMode) {
        $speculativeProfile = [pscustomobject]@{ Arguments = @(); Description = "off (router mode; configure per-model presets for MTP)" }
    } else {
        Write-Host ""
        $defaultNumber = $defaultModelIndex + 1
        $choice = Read-Host "Select model [1-$($models.Count)] (default $defaultNumber)"
        if ([string]::IsNullOrWhiteSpace($choice)) { $choice = $defaultNumber.ToString() }
        $selectedNumber = 0
        if (-not [int]::TryParse($choice, [ref]$selectedNumber) -or $selectedNumber -lt 1 -or $selectedNumber -gt $models.Count) {
            throw "Invalid model selection: $choice"
        }
        $selectedModel = $models[$selectedNumber - 1]
        $env:LLAMA_MODEL = $selectedModel.Name
        $speculativeProfile = Get-LlamaSpeculativeProfile -ServerExecutable $serverExecutable -ModelPath $selectedModel.FullName
    }
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

    $serverArguments = @(
        "-c", $parsedContextLength.ToString(),
        "-b", $runtimeProfile.BatchSize.ToString(), "-ub", $runtimeProfile.UBatchSize.ToString(),
        "-np", "1", "-fa", "auto", "--host", $serverHost, "--port", $parsedServerPort.ToString()
    )
    if ($routerMode) {
        $routerPreset = New-LlamaRouterPreset -ServerExecutable $serverExecutable -Models $models -DefaultModelName $models[$defaultModelIndex].Name -OutputPath (Join-Path $appRoot ".cli\router-models.ini")
        $serverArguments += @("--models-preset", ('"{0}"' -f $routerPreset), "--models-max", $parsedModelsMax.ToString())
    } else {
        $serverArguments = @("-m", ('"{0}"' -f $selectedModel.FullName)) + $serverArguments
    }
    $serverArguments += @($memoryProfile.Arguments)
    $serverArguments += @($speculativeProfile.Arguments)

    Write-Host ""
    Write-Host $(if ($routerMode) { "Starting llama.cpp router for: $modelDirectory (default: $($models[$defaultModelIndex].Name), max loaded: $parsedModelsMax)" } else { "Starting llama.cpp with: $($selectedModel.Name)" })
    Write-Host "llama.cpp path: $llamaDirectory"
    Write-Host ("llama.cpp configured context: {0:N0} tokens" -f $parsedContextLength)
    if (-not [string]::IsNullOrWhiteSpace($llamaDevice)) { Write-Host "llama.cpp device: $llamaDevice $llamaDeviceDescription" }
    Write-Host "llama.cpp profile: $($runtimeProfile.Name) / $($runtimeProfile.Backend), batch $($runtimeProfile.BatchSize), ubatch $($runtimeProfile.UBatchSize)"
    Write-Host "llama.cpp memory: $($memoryProfile.Description)"
    Write-Host "llama.cpp speculative decoding: $($speculativeProfile.Description)"
    Write-Host "llama.cpp listening on: http://${serverHost}:$parsedServerPort"
    Write-Host "Server logs: $stdoutLog"

    $serverProcess = Start-Process `
        -FilePath $serverExecutable `
        -ArgumentList $serverArguments `
        -WorkingDirectory $llamaDirectory `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -WindowStyle Hidden `
        -PassThru
}

try {
    $ready = $false
    $deadline = (Get-Date).AddMinutes(5)
    Write-Host -NoNewline "Loading model"

    while ((Get-Date) -lt $deadline) {
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) {
            $errorOutput = if (-not $serverWasReused -and (Test-Path -LiteralPath $stderrLog)) {
                (Get-Content -LiteralPath $stderrLog -Tail 30) -join [Environment]::NewLine
            } else {
                "The reused llama-server process exited."
            }
            throw "llama-server stopped during startup.`n$errorOutput"
        }

        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                $ready = $true
                break
            }
        } catch {
            # The health endpoint returns an error while the model is loading.
        }

        Write-Host -NoNewline "."
        Start-Sleep -Seconds 1
    }

    Write-Host ""
    if (-not $ready) {
        throw "llama-server did not become ready within 5 minutes. Check $stderrLog"
    }

    Write-Host "llama.cpp is ready. Starting CLI..."
    Write-Host ""
    & npm.cmd run dev:cli
    if ($LASTEXITCODE -ne 0) {
        throw "CLI exited with code $LASTEXITCODE"
    }
} finally {
    if ($serverProcess -and -not $serverProcess.HasExited) {
        Write-Host $(if ($serverWasReused) { "Stopping reused llama.cpp..." } else { "Stopping llama.cpp..." })
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        $serverProcess.WaitForExit(5000) | Out-Null
    }
}
