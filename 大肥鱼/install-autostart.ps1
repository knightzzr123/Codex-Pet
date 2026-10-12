param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$pluginRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$dataDirectory = if ($env:DAFEIYU_DATA_DIR) { [IO.Path]::GetFullPath($env:DAFEIYU_DATA_DIR) } else { Join-Path $env:LOCALAPPDATA 'DafeiyuCodexPet' }
$workDirectory = if ($env:DAFEIYU_WORK_DIR) { [IO.Path]::GetFullPath($env:DAFEIYU_WORK_DIR) } else { Join-Path $dataDirectory 'work' }
$nativeDirectory = Join-Path $workDirectory 'startup'
$shortcutFile = Join-Path ([Environment]::GetFolderPath('Startup')) '大肥鱼-Codex自动启动.lnk'
$statusFile = Join-Path $workDirectory 'autostart-watcher.json'
$taskName = 'DafeiyuCodexStartup-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
try {
    # Compatibility cleanup only. Never register or launch a Windows startup host.
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    if (Test-Path -LiteralPath $shortcutFile) { Remove-Item -LiteralPath $shortcutFile }
    if (Test-Path -LiteralPath $statusFile) {
        $status = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
        $listener = Get-CimInstance Win32_Process -Filter "ProcessId = $($status.pid)"
        if ($listener -and [IO.Path]::GetDirectoryName($listener.ExecutablePath) -eq $nativeDirectory -and
            [IO.Path]::GetFileName($listener.ExecutablePath).StartsWith('dafeiyu-startup-')) {
            Stop-Process -Id $listener.ProcessId -ErrorAction SilentlyContinue
        }
        if ($status.bridgePid) {
            $oldBridge = Get-CimInstance Win32_Process -Filter "ProcessId = $($status.bridgePid)"
            $bridgeEntry = Join-Path $pluginRoot 'src\autostart-bridge.cjs'
            if ($oldBridge -and $oldBridge.ExecutablePath -eq (Join-Path $pluginRoot 'runtime\electron.exe') -and
                $oldBridge.CommandLine.IndexOf($bridgeEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Stop-Process -Id $oldBridge.ProcessId -ErrorAction SilentlyContinue
            }
        }
        Remove-Item -LiteralPath $statusFile
    }
    Write-Output '外部启动入口已清理；角色仅由 Codex 插件服务加载。'
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
