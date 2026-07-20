$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "llama-device.ps1")

function Assert-Equal {
    param($Actual, $Expected, [string]$Label)
    if ($Actual -ne $Expected) {
        throw "$Label expected '$Expected' but received '$Actual'."
    }
}

$env:LLAMA_BATCH_SIZE = $null
$env:LLAMA_UBATCH_SIZE = $null
$env:LLAMA_FIT_TARGET_MIB = $null
$env:LLAMA_FIT_CONTEXT = $null
$env:LLAMA_KV_CACHE_TYPE = $null

$arcName = Resolve-LlamaHardwareProfile -RequestedProfile "auto" -Device "SYCL0" -DeviceDescription "Intel(R) Arc(TM) A770 Graphics"
Assert-Equal $arcName "intel-arc" "Arc auto-detection"
$arc = Get-LlamaRuntimeProfile -Device "SYCL0" -HardwareProfile $arcName -DeviceDescription "Intel(R) Arc(TM) A770 Graphics"
Assert-Equal $arc.BatchSize 512 "Arc batch"
Assert-Equal $arc.UBatchSize 256 "Arc ubatch"
$arcMemory = Get-LlamaMemoryProfile -Device "SYCL0" -HardwareProfile $arcName
Assert-Equal $arcMemory.CacheType "q8_0" "Arc KV cache"
Assert-Equal $arcMemory.FitTargetMiB 1024 "Arc fit margin"

$rtxName = Resolve-LlamaHardwareProfile -RequestedProfile "auto" -Device "CUDA0" -DeviceDescription "NVIDIA GeForce RTX 4070 SUPER"
Assert-Equal $rtxName "rtx-4070-super" "RTX auto-detection"
$rtx = Get-LlamaRuntimeProfile -Device "CUDA0" -HardwareProfile $rtxName -DeviceDescription "NVIDIA GeForce RTX 4070 SUPER"
Assert-Equal $rtx.BatchSize 1024 "RTX batch"
Assert-Equal $rtx.UBatchSize 512 "RTX ubatch"
$rtxMemory = Get-LlamaMemoryProfile -Device "CUDA0" -HardwareProfile $rtxName
Assert-Equal $rtxMemory.CacheType "q8_0" "RTX KV cache"

$generic = Get-LlamaRuntimeProfile -Device "Vulkan0" -HardwareProfile "default"
Assert-Equal $generic.BatchSize 512 "Generic Vulkan batch"
Assert-Equal $generic.UBatchSize 256 "Generic Vulkan ubatch"

$env:LLAMA_BATCH_SIZE = "384"
$env:LLAMA_UBATCH_SIZE = "96"
$overridden = Get-LlamaRuntimeProfile -Device "SYCL0" -HardwareProfile "intel-arc"
Assert-Equal $overridden.BatchSize 384 "Batch override"
Assert-Equal $overridden.UBatchSize 96 "Ubatch override"

Write-Host "Intel Arc and RTX 4070 SUPER hardware profile tests passed."
