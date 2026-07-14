$ErrorActionPreference = "Stop"

$llamaDirectory = if ($env:LLAMA_CPP_DIR) {
    $env:LLAMA_CPP_DIR
} else {
    "D:\llama.cpp\llama-b9908-bin-win-sycl-x64"
}

$launcher = Join-Path $llamaDirectory "run-llama.bat"

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "llama.cpp launcher not found: $launcher"
}

Write-Host "Starting llama.cpp from: $llamaDirectory"
Write-Host "The CLI will connect to: http://127.0.0.1:8080"
Write-Host ""

& $launcher
