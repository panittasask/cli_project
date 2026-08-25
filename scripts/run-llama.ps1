$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "start-llama.ps1")
exit $LASTEXITCODE
