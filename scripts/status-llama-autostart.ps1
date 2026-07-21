param(
    [string]$TaskName = "LocalLlamaServer"
)

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Scheduled task: $($task.State)"
    Write-Host "Last result: $($info.LastTaskResult)"
    Write-Host "Last run: $($info.LastRunTime)"
} else {
    Write-Host "Scheduled task: not installed"
}

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 5
    Write-Host "llama.cpp health: $($health.status)"
    $models = @((Invoke-RestMethod -Uri "http://127.0.0.1:8080/models" -TimeoutSec 10).data)
    $models | ForEach-Object { Write-Host ("  [{0}] {1}" -f $_.status.value, $_.id) }
} catch {
    Write-Host "llama.cpp health: unavailable"
    Write-Host $_.Exception.Message
    exit 1
}
