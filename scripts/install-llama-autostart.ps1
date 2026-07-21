param(
    [string]$TaskName = "LocalLlamaServer"
)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdministrator) {
    Write-Host "Administrator permission is required. Opening UAC..."
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -TaskName `"$TaskName`""
    $elevated = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    exit $elevated.ExitCode
}

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$serviceScript = Join-Path $PSScriptRoot "start-llama-service.ps1"
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$actionArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$serviceScript`""
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $actionArguments -WorkingDirectory $appRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description "Starts the local llama.cpp router server at Windows startup." -Force | Out-Null

Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Start-ScheduledTask -TaskName $TaskName

$deadline = (Get-Date).AddMinutes(5)
$ready = $false
$loaded = @()
while ((Get-Date) -lt $deadline) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 3
        if ($health.status -eq "ok") {
            $loaded = @((Invoke-RestMethod -Uri "http://127.0.0.1:8080/models" -TimeoutSec 10).data | Where-Object { $_.status.value -eq "loaded" })
            if ($loaded.Count -gt 0) {
                $ready = $true
                break
            }
        }
    } catch {}
    Start-Sleep -Seconds 2
}

if (-not $ready) {
    $task = Get-ScheduledTaskInfo -TaskName $TaskName
    throw "Scheduled task was installed but llama.cpp did not become ready. LastTaskResult=$($task.LastTaskResult). Check .cli\logs\llama-autostart.log."
}

Write-Host "Installed and started scheduled task: $TaskName"
Write-Host "Startup account: SYSTEM"
Write-Host "Health: ok"
Write-Host "Loaded model: $(if ($loaded.Count -gt 0) { $loaded[0].id } else { 'none' })"
Write-Host "Logs: $(Join-Path $appRoot '.cli\logs\llama-autostart.log')"
