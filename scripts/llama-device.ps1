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
        "SYCL" { @{ BatchSize = 256; UBatchSize = 128 } }
        "Vulkan" { @{ BatchSize = 512; UBatchSize = 256 } }
        default { @{ BatchSize = 256; UBatchSize = 128 } }
    }
    $batchSize = if ($env:LLAMA_BATCH_SIZE) { [int]$env:LLAMA_BATCH_SIZE } else { $defaults.BatchSize }
    $uBatchSize = if ($env:LLAMA_UBATCH_SIZE) { [int]$env:LLAMA_UBATCH_SIZE } else { $defaults.UBatchSize }
    if ($batchSize -lt 1 -or $uBatchSize -lt 1 -or $uBatchSize -gt $batchSize) { throw "Invalid runtime batch profile: batch=$batchSize ubatch=$uBatchSize" }
    return [pscustomobject]@{ Backend = $backend; Device = $Device; BatchSize = $batchSize; UBatchSize = $uBatchSize }
}

function Get-LlamaMemoryProfile {
    param([AllowEmptyString()][string]$Device = "")

    $backend = if ($Device -match '^CUDA') { "CUDA" } elseif ($Device -match '^SYCL') { "SYCL" } elseif ($Device -match '^Vulkan') { "Vulkan" } else { "CPU" }
    $arguments = @()
    if (-not [string]::IsNullOrWhiteSpace($Device)) {
        # Do not force -ngl all. llama.cpp defaults to automatic layer fitting;
        # an explicit full offload prevents --fit from recovering when the
        # model, KV cache, and compute buffers exceed accelerator memory.
        $arguments += @("--device", $Device, "--fit", "on", "-fitc", "4096", "-fitt", "1024")
    }
    if ($backend -eq "SYCL") {
        # Long contexts otherwise consume several additional GiB in f16 KV.
        $arguments += @("-ctk", "q8_0", "-ctv", "q8_0")
    }

    return [pscustomobject]@{
        Backend = $backend
        Arguments = $arguments
        Description = if ($Device) { "automatic GPU layers, fit target 1024 MiB, KV $(if ($backend -eq 'SYCL') { 'q8_0' } else { 'f16' })" } else { "CPU defaults" }
    }
}

function Get-LlamaSpeculativeProfile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServerExecutable,

        [Parameter(Mandatory = $true)]
        [string]$ModelPath
    )

    $modelName = [IO.Path]::GetFileName($ModelPath)
    $isMtpModel = $modelName -match '(?i)(?:^|[-_.])MTP(?:[-_.]|$)'
    $mtpDisabled = $env:LLAMA_MTP -match '^(?i:0|false|off|no)$'
    if (-not $isMtpModel) {
        return [pscustomobject]@{ Enabled = $false; Arguments = @(); Description = "off (normal model)" }
    }
    if ($mtpDisabled) {
        return [pscustomobject]@{ Enabled = $false; Arguments = @(); Description = "off (LLAMA_MTP override)" }
    }

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "SilentlyContinue"
        $helpText = (@(& $ServerExecutable --help 2>&1) | ForEach-Object { $_.ToString() }) -join "`n"
    } finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($helpText -notmatch '(?m)--spec-type[^\r\n]*draft-mtp') {
        return [pscustomobject]@{
            Enabled = $false
            Arguments = @()
            Description = "off (MTP model detected, but this llama.cpp build does not support draft-mtp)"
        }
    }

    return [pscustomobject]@{
        Enabled = $true
        Arguments = @("--spec-type", "draft-mtp", "--spec-draft-n-max", "6")
        Description = "draft-mtp (auto, draft max 6)"
    }
}
