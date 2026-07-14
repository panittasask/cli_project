$ErrorActionPreference = "Stop"

function Get-CliSettings {
    $settingsPath = Join-Path $PSScriptRoot "..\.cli\settings.json"
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
        return [pscustomobject]@{}
    }

    return Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
}

$settings = Get-CliSettings

$llamaDirectory = if ($env:LLAMA_CPP_DIR) { $env:LLAMA_CPP_DIR } elseif ($settings.llamaCppPath) { $settings.llamaCppPath } else { "D:\llama.cpp\llama-b9908-bin-win-sycl-x64" }
$modelDirectory = if ($env:LLAMA_MODEL_DIR) { $env:LLAMA_MODEL_DIR } elseif ($settings.modelPath) { $settings.modelPath } else { "D:\Model" }
$llamaDevice = if ($env:LLAMA_DEVICE) { $env:LLAMA_DEVICE } elseif ($settings.device) { $settings.device } else { "" }

$serverExecutable = Join-Path $llamaDirectory "llama-server.exe"
$logDirectory = Join-Path $PSScriptRoot "..\.cli\logs"
$stdoutLog = Join-Path $logDirectory "llama-server.log"
$stderrLog = Join-Path $logDirectory "llama-server-error.log"
$healthUrl = "http://127.0.0.1:8080/health"

if (-not (Test-Path -LiteralPath $serverExecutable -PathType Leaf)) {
    throw "llama-server.exe not found: $serverExecutable"
}

if (-not (Test-Path -LiteralPath $modelDirectory -PathType Container)) {
    throw "Model directory not found: $modelDirectory"
}

$portCheck = [System.Net.Sockets.TcpClient]::new()
$portInUse = $false
try {
    $connectTask = $portCheck.ConnectAsync("127.0.0.1", 8080)
    try {
        $portInUse = $connectTask.Wait(500) -and $portCheck.Connected
    } catch {
        $portInUse = $false
    }
} finally {
    $portCheck.Dispose()
}

if ($portInUse) {
    throw "Port 8080 is already in use. Stop the existing server before using npm run dev."
}

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

Write-Host ""
Write-Host "Available models"
Write-Host "================"
for ($index = 0; $index -lt $models.Count; $index += 1) {
    $sizeGb = [Math]::Round($models[$index].Length / 1GB, 2)
    $marker = if ($index -eq $defaultModelIndex) { " *" } else { "" }
    Write-Host ("[{0}] {1} ({2} GB){3}" -f ($index + 1), $models[$index].Name, $sizeGb, $marker)
}

Write-Host ""
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
$env:LLAMA_MODEL = $selectedModel.Name

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

$serverArguments = @(
    "-m", ('"{0}"' -f $selectedModel.FullName),
    "-c", "65536",
    "-np", "1",
    "-fa", "auto",
    "--host", "127.0.0.1",
    "--port", "8080"
)

if (-not [string]::IsNullOrWhiteSpace($llamaDevice)) {
    $serverArguments += @("--device", $llamaDevice, "-ngl", "all")
}

Write-Host ""
Write-Host "Starting llama.cpp with: $($selectedModel.Name)"
Write-Host "llama.cpp path: $llamaDirectory"
if (-not [string]::IsNullOrWhiteSpace($llamaDevice)) {
    Write-Host "llama.cpp device: $llamaDevice"
}
Write-Host "Server logs: $stdoutLog"

$serverProcess = Start-Process `
    -FilePath $serverExecutable `
    -ArgumentList $serverArguments `
    -WorkingDirectory $llamaDirectory `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -WindowStyle Hidden `
    -PassThru

try {
    $ready = $false
    $deadline = (Get-Date).AddMinutes(5)
    Write-Host -NoNewline "Loading model"

    while ((Get-Date) -lt $deadline) {
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) {
            $errorOutput = if (Test-Path -LiteralPath $stderrLog) {
                (Get-Content -LiteralPath $stderrLog -Tail 30) -join [Environment]::NewLine
            } else {
                "No server error log was produced."
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
        Write-Host "Stopping llama.cpp..."
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        $serverProcess.WaitForExit(5000) | Out-Null
    }
}
