param(
    [int]$BackendProcessId,
    [int]$ClientProcessId,
    [int]$DatabaseProcessId,
    [string]$OutputPath,
    [string]$PhasePath,
    [string]$StopPath,
    [string]$GuardPath
)

$ErrorActionPreference = 'Stop'
$processorCount = [Environment]::ProcessorCount
$previous = @{}
$writer = [System.IO.StreamWriter]::new($OutputPath, $false)
$writer.AutoFlush = $true
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$nextMemoryCheck = 0

try {
    while (-not (Test-Path -LiteralPath $StopPath)) {
        $elapsed = $clock.Elapsed.TotalSeconds
        $phase = try { [System.IO.File]::ReadAllText($PhasePath) } catch { 'setup' }
        foreach ($entry in @(
            @{ Name = 'backend'; ProcessId = $BackendProcessId },
            @{ Name = 'client'; ProcessId = $ClientProcessId },
            @{ Name = 'sqlserver'; ProcessId = $DatabaseProcessId }
        )) {
            if ($entry.ProcessId -le 0) { continue }
            try {
                $sampledProcess = [System.Diagnostics.Process]::GetProcessById($entry.ProcessId)
                $processorTime = $sampledProcess.TotalProcessorTime
                $cpuSeconds = if ($null -ne $processorTime) { $processorTime.TotalSeconds } else { $null }
                $oneCorePercent = $null
                if ($null -ne $cpuSeconds -and $previous.ContainsKey($entry.Name) -and
                    $null -ne $previous[$entry.Name].Cpu) {
                    $delta = $elapsed - $previous[$entry.Name].Elapsed
                    if ($delta -gt 0) {
                        $oneCorePercent = 100 * ($cpuSeconds - $previous[$entry.Name].Cpu) / $delta
                    }
                }
                $previous[$entry.Name] = @{ Elapsed = $elapsed; Cpu = $cpuSeconds }
                $record = [ordered]@{
                    at = [DateTimeOffset]::UtcNow.ToString('O')
                    phase = $phase
                    process = $entry.Name
                    cpuMachinePercent = if ($null -ne $oneCorePercent) {
                        [Math]::Round($oneCorePercent / $processorCount, 3)
                    } else { $null }
                    cpuOneCorePercent = if ($null -ne $oneCorePercent) {
                        [Math]::Round($oneCorePercent, 3)
                    } else { $null }
                    workingSetMiB = [Math]::Round($sampledProcess.WorkingSet64 / 1MB, 2)
                    privateMiB = [Math]::Round($sampledProcess.PrivateMemorySize64 / 1MB, 2)
                    threads = $sampledProcess.Threads.Count
                    handles = $sampledProcess.HandleCount
                }
                $writer.WriteLine(($record | ConvertTo-Json -Compress))
                if ($entry.Name -eq 'backend' -and $sampledProcess.PrivateMemorySize64 -gt 1536MB) {
                    [System.IO.File]::WriteAllText($GuardPath, 'Backend private memory exceeded 1536 MiB.')
                }
                $sampledProcess.Dispose()
            } catch {
                if ($entry.Name -eq 'backend' -and -not (Test-Path -LiteralPath $StopPath)) {
                    [System.IO.File]::WriteAllText($GuardPath, 'Backend process is no longer available.')
                }
            }
        }
        if ($elapsed -ge $nextMemoryCheck) {
            $systemMemory = Get-CimInstance Win32_OperatingSystem
            if ($systemMemory.FreePhysicalMemory -lt 1MB) {
                [System.IO.File]::WriteAllText($GuardPath, 'Available physical memory fell below 1 GiB.')
            }
            $nextMemoryCheck = $elapsed + 5
        }
        Start-Sleep -Milliseconds 1000
    }
} finally {
    $writer.Dispose()
}
