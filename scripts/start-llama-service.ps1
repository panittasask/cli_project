$ErrorActionPreference = "Stop"
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDirectory = Join-Path $appRoot ".cli\logs"
$logPath = Join-Path $logDirectory "llama-autostart.log"
$previousLogPath = Join-Path $logDirectory "llama-autostart.previous.log"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 20MB) {
    Move-Item -LiteralPath $logPath -Destination $previousLogPath -Force
}

$env:LLAMA_ROUTER_MODE = "true"
if (-not $env:LLAMA_MODELS_MAX) { $env:LLAMA_MODELS_MAX = "1" }

Start-Transcript -Path $logPath -Append | Out-Null
try {
    Write-Host "[$(Get-Date -Format o)] Starting LocalLlamaServer from $appRoot"
    & (Join-Path $PSScriptRoot "start-llama.ps1")
    $exitCode = $LASTEXITCODE
    throw "llama-server exited unexpectedly with code $exitCode"
} catch {
    Write-Error $_
    exit 1
} finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}

