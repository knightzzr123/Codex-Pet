param([string]$CodexExe, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$pluginRoot = $PSScriptRoot

function Find-Codex {
    if ($CodexExe) { return $CodexExe }
    if ($env:CODEX_EXE) { return $env:CODEX_EXE }
    $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $binRoot) {
        $candidate = Get-ChildItem -LiteralPath $binRoot -Directory |
            ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } -Descending |
            Select-Object -First 1
        if ($candidate) { return $candidate }
    }
    $command = Get-Command codex.exe,codex -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    throw 'Codex was not found. Install Codex desktop, or pass -CodexExe with its CLI path.'
}

function Invoke-CodexCommand([string[]]$Arguments) {
    # Windows PowerShell treats redirected native stderr as ErrorRecord objects.
    $ErrorActionPreference = 'Continue'
    $output = @(& $resolvedCodex @Arguments 2>&1 | ForEach-Object { "$_" })
    return @{ ExitCode=$LASTEXITCODE; Output=($output -join [Environment]::NewLine) }
}

function Register-Marketplace {
    $added = Invoke-CodexCommand @('plugin', 'marketplace', 'add', $pluginRoot, '--json')
    if ($added.ExitCode -eq 0) { Write-Output $added.Output; return }
    if ($added.Output -notmatch "marketplace 'dafeiyu-plugins' is already added from a different source") {
        throw ('Codex could not register this marketplace: ' + $added.Output)
    }
    $listed = Invoke-CodexCommand @('plugin', 'marketplace', 'list', '--json')
    if ($listed.ExitCode -ne 0) { throw 'Could not inspect the previous Dafeiyu marketplace.' }
    $previous = ($listed.Output | ConvertFrom-Json).marketplaces |
        Where-Object { $_.name -eq 'dafeiyu-plugins' } | Select-Object -First 1
    if (-not $previous.root) { throw 'The previous Dafeiyu marketplace has no recoverable source.' }
    $removed = Invoke-CodexCommand @('plugin', 'marketplace', 'remove', 'dafeiyu-plugins', '--json')
    if ($removed.ExitCode -ne 0) { throw 'Could not update the previous Dafeiyu marketplace.' }
    $replaced = Invoke-CodexCommand @('plugin', 'marketplace', 'add', $pluginRoot, '--json')
    if ($replaced.ExitCode -ne 0) {
        $restored = Invoke-CodexCommand @('plugin', 'marketplace', 'add', $previous.root, '--json')
        if ($restored.ExitCode -ne 0) { throw 'Marketplace update and rollback both failed. Re-run the installer from the previous package.' }
        throw 'Marketplace update failed; the previous source was restored.'
    }
    Write-Output $replaced.Output
}

try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'This package requires 64-bit Windows.' }
    foreach ($required in @('plugin.json', 'prepare-runtime.ps1', 'runtime-manifest.json', 'src\plugin-server.cjs', '.agents\plugins\marketplace.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $pluginRoot $required))) {
            throw "Incomplete package: $required is missing. Extract the entire ZIP first."
        }
    }
    $resolvedCodex = Find-Codex
    if ($DryRun) {
        @{ pluginRoot=$pluginRoot; codexExe=$resolvedCodex; pluginId='dafeiyu-codex-pet@dafeiyu-plugins' } |
            ConvertTo-Json -Compress
        exit 0
    }
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $pluginRoot 'prepare-runtime.ps1') -Verify
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the bundled runtime.' }
    # Avoid another project's repo marketplace shadowing this package's source.
    Push-Location -LiteralPath $env:SystemRoot
    try {
        Register-Marketplace
        $installed = Invoke-CodexCommand @('plugin', 'add', 'dafeiyu-codex-pet@dafeiyu-plugins', '--json')
        if ($installed.ExitCode -ne 0) { throw ('Codex could not install this plugin: ' + $installed.Output) }
        Write-Output $installed.Output
        $expectedVersion = (Get-Content -LiteralPath (Join-Path $pluginRoot 'plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
        if (($installed.Output | ConvertFrom-Json).version -ne $expectedVersion) { throw 'Codex installed a different package version.' }
    } finally { Pop-Location }
    $previousElectronMode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
        & (Join-Path $pluginRoot 'runtime\electron.exe') (Join-Path $pluginRoot 'src\register-native-startup.cjs') $resolvedCodex
        if ($LASTEXITCODE -ne 0) { throw 'Codex could not register native plugin startup.' }
    } finally { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $previousElectronMode, 'Process') }
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $pluginRoot 'install-autostart.ps1') -Remove
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove legacy external startup entries.' }
    Write-Host 'Installed native startup. Enable Dafeiyu in Plugins, then restart Codex.'
    Write-Host 'If the old TEST pet is installed, disable that version to avoid two pets.'
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
