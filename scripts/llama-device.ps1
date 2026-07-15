function Get-LlamaDevices {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServerExecutable
    )

    $deviceOutput = @(& $ServerExecutable --list-devices 2>&1)
    $devices = @()

    foreach ($line in $deviceOutput) {
        $text = $line.ToString()
        if ($text -match '^\s*([A-Za-z][A-Za-z0-9_-]*\d+):\s*(.+)$') {
            $devices += [pscustomobject]@{
                Name = $Matches[1]
                Description = $Matches[2]
            }
        }
    }

    return $devices
}

function Resolve-LlamaDevice {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServerExecutable,

        [AllowEmptyString()]
        [string]$RequestedDevice = "auto"
    )

    $devices = @(Get-LlamaDevices -ServerExecutable $ServerExecutable)
    $requested = $RequestedDevice.Trim()
    $useAutomaticSelection = [string]::IsNullOrWhiteSpace($requested) -or $requested -ieq "auto"

    if ($devices.Count -eq 0) {
        if (-not $useAutomaticSelection) {
            throw "Device '$requested' was requested, but this llama-server build reported no accelerator devices."
        }

        return ""
    }

    if ($useAutomaticSelection) {
        return $devices[0].Name
    }

    $match = @($devices | Where-Object { $_.Name -ieq $requested } | Select-Object -First 1)
    if ($match.Count -eq 0) {
        $available = ($devices | ForEach-Object { $_.Name }) -join ", "
        throw "Device '$requested' is not available in this llama-server build. Available devices: $available. Set device to 'auto' to select automatically."
    }

    return $match[0].Name
}

function Get-LlamaRuntimeProfile {
    param([AllowEmptyString()][string]$Device = "")
    $backend = if ($Device -match '^CUDA') { "CUDA" } elseif ($Device -match '^SYCL') { "SYCL" } elseif ($Device -match '^Vulkan') { "Vulkan" } else { "CPU" }
    $defaults = switch ($backend) {
        "CUDA" { @{ BatchSize = 1024; UBatchSize = 512 } }
        "SYCL" { @{ BatchSize = 512; UBatchSize = 256 } }
        "Vulkan" { @{ BatchSize = 512; UBatchSize = 256 } }
        default { @{ BatchSize = 256; UBatchSize = 128 } }
    }
    $batchSize = if ($env:LLAMA_BATCH_SIZE) { [int]$env:LLAMA_BATCH_SIZE } else { $defaults.BatchSize }
    $uBatchSize = if ($env:LLAMA_UBATCH_SIZE) { [int]$env:LLAMA_UBATCH_SIZE } else { $defaults.UBatchSize }
    if ($batchSize -lt 1 -or $uBatchSize -lt 1 -or $uBatchSize -gt $batchSize) { throw "Invalid runtime batch profile: batch=$batchSize ubatch=$uBatchSize" }
    return [pscustomobject]@{ Backend = $backend; Device = $Device; BatchSize = $batchSize; UBatchSize = $uBatchSize }
}
