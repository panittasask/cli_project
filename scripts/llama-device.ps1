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

function Get-LlamaDeviceDescription {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServerExecutable,

        [AllowEmptyString()]
        [string]$Device = ""
    )

    if ([string]::IsNullOrWhiteSpace($Device)) { return "" }
    $match = @(Get-LlamaDevices -ServerExecutable $ServerExecutable | Where-Object { $_.Name -ieq $Device } | Select-Object -First 1)
    if ($match.Count -gt 0) { return $match[0].Description }
    return ""
}

function Resolve-LlamaHardwareProfile {
    param(
        [AllowEmptyString()][string]$RequestedProfile = "auto",
        [AllowEmptyString()][string]$Device = "",
        [AllowEmptyString()][string]$DeviceDescription = ""
    )

    $requested = $RequestedProfile.Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($requested)) { $requested = "auto" }
    $allowed = @("auto", "intel-arc", "rtx-4070-super", "default")
    if ($requested -notin $allowed) {
        throw "Unknown hardware profile '$RequestedProfile'. Available profiles: auto, intel-arc, rtx-4070-super, default."
    }
    if ($requested -ne "auto") { return $requested }

    $identity = "$Device $DeviceDescription"
    if ($identity -match '(?i)RTX\s*4070\s*SUPER') { return "rtx-4070-super" }
    if ($identity -match '(?i)(?:Intel.*Arc|Arc.*Intel|\bArc\s+[AB]?[0-9]{3,4}\b)') { return "intel-arc" }
    return "default"
}

function Get-LlamaRuntimeProfile {
    param(
        [AllowEmptyString()][string]$Device = "",
        [AllowEmptyString()][string]$HardwareProfile = "auto",
        [AllowEmptyString()][string]$DeviceDescription = ""
    )
    $backend = if ($Device -match '^CUDA') { "CUDA" } elseif ($Device -match '^SYCL') { "SYCL" } elseif ($Device -match '^Vulkan') { "Vulkan" } else { "CPU" }
    $profileName = Resolve-LlamaHardwareProfile -RequestedProfile $HardwareProfile -Device $Device -DeviceDescription $DeviceDescription
    $defaults = switch ($profileName) {
        # Measured on the local Arc 140T 16 GB: 512/256 improved pp512 from
        # 86.02 to 116.65 t/s while tg128 remained stable (7.63 -> 7.74 t/s).
        "intel-arc" { @{ BatchSize = 512; UBatchSize = 256 } }
        # RTX 4070 SUPER has 12 GB VRAM. Keep the physical batch conservative
        # because fit is disabled and all model layers are requested on GPU.
        "rtx-4070-super" { @{ BatchSize = 256; UBatchSize = 128 } }
        default {
            switch ($backend) {
                "CUDA" { @{ BatchSize = 256; UBatchSize = 128 } }
                "SYCL" { @{ BatchSize = 256; UBatchSize = 128 } }
                "Vulkan" { @{ BatchSize = 512; UBatchSize = 256 } }
                default { @{ BatchSize = 256; UBatchSize = 128 } }
            }
        }
    }
    $batchSize = if ($env:LLAMA_BATCH_SIZE) { [int]$env:LLAMA_BATCH_SIZE } else { $defaults.BatchSize }
    $uBatchSize = if ($env:LLAMA_UBATCH_SIZE) { [int]$env:LLAMA_UBATCH_SIZE } else { $defaults.UBatchSize }
    if ($batchSize -lt 1 -or $uBatchSize -lt 1 -or $uBatchSize -gt $batchSize) { throw "Invalid runtime batch profile: batch=$batchSize ubatch=$uBatchSize" }
    return [pscustomobject]@{ Name = $profileName; Backend = $backend; Device = $Device; DeviceDescription = $DeviceDescription; BatchSize = $batchSize; UBatchSize = $uBatchSize }
}

function Set-LlamaRuntimeEnvironment {
    param(
        [AllowNull()]
        [object]$Settings
    )

    $runtime = if ($Settings -and $Settings.llamaRuntime) { $Settings.llamaRuntime } else { $null }
    if (-not $runtime) { return }

    $mappings = @(
        @("LLAMA_BATCH_SIZE", "batchSize"),
        @("LLAMA_UBATCH_SIZE", "ubatchSize"),
        @("LLAMA_KV_CACHE_TYPE", "kvCacheType"),
        @("LLAMA_ARG_FIT", "fit"),
        @("LLAMA_ARG_N_GPU_LAYERS", "gpuLayers"),
        # llama.cpp exposes --reasoning-budget through LLAMA_ARG_THINK_BUDGET.
        @("LLAMA_ARG_THINK_BUDGET", "reasoningBudget")
    )
    foreach ($mapping in $mappings) {
        $environmentName = $mapping[0]
        $settingName = $mapping[1]
        $current = [Environment]::GetEnvironmentVariable($environmentName, "Process")
        $configured = $runtime.$settingName
        if ([string]::IsNullOrWhiteSpace($current) -and $null -ne $configured) {
            Set-Item -Path "Env:$environmentName" -Value ([string]$configured)
        }
    }
}

function Get-LlamaMemoryProfile {
    param(
        [AllowEmptyString()][string]$Device = "",
        [AllowEmptyString()][string]$HardwareProfile = "auto",
        [AllowEmptyString()][string]$DeviceDescription = ""
    )

    $backend = if ($Device -match '^CUDA') { "CUDA" } elseif ($Device -match '^SYCL') { "SYCL" } elseif ($Device -match '^Vulkan') { "Vulkan" } else { "CPU" }
    $profileName = Resolve-LlamaHardwareProfile -RequestedProfile $HardwareProfile -Device $Device -DeviceDescription $DeviceDescription
    $fitTarget = if ($env:LLAMA_FIT_TARGET_MIB) { [int]$env:LLAMA_FIT_TARGET_MIB } else { 1024 }
    $fitContext = if ($env:LLAMA_FIT_CONTEXT) { [int]$env:LLAMA_FIT_CONTEXT } else { 4096 }
    if ($fitTarget -lt 256 -or $fitContext -lt 512) { throw "Invalid memory fit profile: target=$fitTarget MiB minimum-context=$fitContext" }
    $defaultCacheType = if ($profileName -eq "intel-arc" -or $profileName -eq "rtx-4070-super" -or $backend -eq "SYCL") { "q8_0" } else { "f16" }
    $cacheType = if ($env:LLAMA_KV_CACHE_TYPE) { $env:LLAMA_KV_CACHE_TYPE.Trim().ToLowerInvariant() } else { $defaultCacheType }
    $allowedCacheTypes = @("f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1")
    if ($cacheType -notin $allowedCacheTypes) { throw "Invalid KV cache type '$cacheType'." }
    $fitMode = if ($env:LLAMA_ARG_FIT) { $env:LLAMA_ARG_FIT.Trim().ToLowerInvariant() } else { "off" }
    if ($fitMode -notin @("on", "off")) { throw "Invalid llama.cpp fit mode '$fitMode'. Use on or off." }
    $gpuLayers = if ($env:LLAMA_ARG_N_GPU_LAYERS) { $env:LLAMA_ARG_N_GPU_LAYERS.Trim().ToLowerInvariant() } else { "all" }
    if ($gpuLayers -notmatch '^(?:all|auto|\d+)$') { throw "Invalid llama.cpp GPU layer setting '$gpuLayers'. Use all, auto, or a non-negative integer." }
    $arguments = @()
    if (-not [string]::IsNullOrWhiteSpace($Device)) {
        # The configured runtime profile controls whether llama.cpp may fit or
        # spill layers. With fit off and all layers requested, an over-sized
        # model should fail with CUDA OOM instead of silently spilling to RAM.
        $arguments += @("--device", $Device, "--fit", $fitMode, "--gpu-layers", $gpuLayers)
    }
    if (-not [string]::IsNullOrWhiteSpace($Device) -and $cacheType -ne "f16") {
        # Quantized KV protects accelerator memory at longer contexts. It is
        # especially useful for Arc and the 12 GB RTX 4070 SUPER preset.
        $arguments += @("-ctk", $cacheType, "-ctv", $cacheType)
    }

    return [pscustomobject]@{
        Name = $profileName
        Backend = $backend
        CacheType = $cacheType
        FitTargetMiB = $fitTarget
        FitContext = $fitContext
        Arguments = $arguments
        Description = if ($Device) { "GPU layers $gpuLayers, fit $fitMode, KV $cacheType" } else { "CPU defaults" }
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

function New-LlamaRouterPreset {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServerExecutable,

        [Parameter(Mandatory = $true)]
        [System.IO.FileInfo[]]$Models,

        [Parameter(Mandatory = $true)]
        [string]$DefaultModelName,

        [Parameter(Mandatory = $true)]
        [ValidateRange(512, [int]::MaxValue)]
        [int]$ContextLength,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("version = 1")
    $lines.Add("")
    $lines.Add("[*]")
    $lines.Add("ctx-size = $ContextLength")
    $lines.Add("")
    foreach ($model in $Models) {
        $modelId = [IO.Path]::GetFileNameWithoutExtension($model.Name)
        $speculative = Get-LlamaSpeculativeProfile -ServerExecutable $ServerExecutable -ModelPath $model.FullName
        $lines.Add("[$modelId]")
        $lines.Add("model = $($model.FullName)")
        $loadOnStartup = ($model.Name -ieq $DefaultModelName).ToString().ToLowerInvariant()
        $lines.Add("load-on-startup = $loadOnStartup")
        $lines.Add("stop-timeout = 15")
        if ($speculative.Arguments.Count -gt 0) {
            foreach ($index in 0..($speculative.Arguments.Count - 1)) {
                if ($index % 2 -ne 0) { continue }
                $key = $speculative.Arguments[$index].TrimStart("-")
                $value = $speculative.Arguments[$index + 1]
                $lines.Add("$key = $value")
            }
        }
        $lines.Add("")
    }

    $outputDirectory = Split-Path -Parent $OutputPath
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    [IO.File]::WriteAllLines($OutputPath, $lines, [Text.UTF8Encoding]::new($false))
    return $OutputPath
}
