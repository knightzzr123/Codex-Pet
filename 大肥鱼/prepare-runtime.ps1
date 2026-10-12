param([switch]$Verify)
$ErrorActionPreference = 'Stop'
$pluginRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$runtime = Join-Path $pluginRoot 'runtime'
$stage = $null
$locked = $false
$mutex = $null

function Get-Sha256([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}

function Test-Runtime([string]$Directory, $Manifest, [bool]$CheckHashes) {
    foreach ($file in $Manifest.files) {
        $target = [IO.Path]::GetFullPath((Join-Path $Directory $file.path))
        if (-not $target.StartsWith($Directory + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Invalid runtime manifest path.'
        }
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { return $false }
        if ((Get-Item -LiteralPath $target).Length -ne $file.bytes) { return $false }
        if ($CheckHashes -and (Get-Sha256 $target) -ne $file.sha256) {
            return $false
        }
    }
    return $true
}

try {
    $manifest = Get-Content -LiteralPath (Join-Path $pluginRoot 'runtime-manifest.json') -Raw | ConvertFrom-Json
    if (-not $manifest.files -or -not ($manifest.files | Where-Object path -eq 'electron.exe')) {
        throw 'Incomplete runtime manifest.'
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($pluginRoot.ToLowerInvariant()))).Replace('-', '') }
    finally { $sha.Dispose() }
    $mutex = New-Object Threading.Mutex($false, ('Local\DafeiyuRuntime-' + $key))
    try { $locked = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another process is preparing this runtime. Try again shortly.' }
    $readyFile = Join-Path $runtime '.dafeiyu-ready.json'
    $ready = $null
    if (Test-Path -LiteralPath $readyFile) {
        try { $ready = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json } catch {}
    }
    $archive = Join-Path $pluginRoot 'runtime.7z'
    if ($ready.archiveSha256 -eq $manifest.sha256 -and (Test-Runtime $runtime $manifest ([bool]$Verify))) {
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
        exit 0
    }
    $extractor = Join-Path $pluginRoot 'tools\7zip\7zr.exe'
    if ((Get-Sha256 $archive) -ne $manifest.sha256) {
        throw 'Runtime archive is damaged. Extract the plugin ZIP again.'
    }
    if ((Get-Sha256 $extractor) -ne $manifest.extractorSha256) {
        throw 'Runtime extractor is damaged. Extract the plugin ZIP again.'
    }
    if (Test-Path -LiteralPath $runtime) {
        # Do not overwrite a running or partially installed Electron directory.
        if (-not (Test-Runtime $runtime $manifest $true)) {
            throw 'Runtime directory is incomplete. Extract the plugin ZIP into a new folder.'
        }
    } else {
        [Console]::Error.WriteLine('Preparing Dafeiyu runtime for first use...')
        $stage = Join-Path $pluginRoot ('.runtime-prepare-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stage | Out-Null
        & $extractor x $archive ('-o' + $stage) -y -bd -bb0 -bso0 -bse2 -bsp0
        if ($LASTEXITCODE -ne 0) { throw 'Runtime extraction failed.' }
        $stagedRuntime = Join-Path $stage 'runtime'
        if (-not (Test-Runtime $stagedRuntime $manifest $true)) { throw 'Extracted runtime failed verification.' }
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($stage)) -ne $pluginRoot -or
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($runtime)) -ne $pluginRoot) {
            throw 'Unexpected runtime staging path.'
        }
        Move-Item -LiteralPath $stagedRuntime -Destination $runtime
    }
    [IO.File]::WriteAllText($readyFile, (@{ archiveSha256=$manifest.sha256; electron=$manifest.electron } | ConvertTo-Json -Compress))
    # The original release ZIP remains available; avoid keeping two copies of the runtime in each installation.
    Remove-Item -LiteralPath $archive -Force
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) {
        $target = [IO.Path]::GetFullPath($stage)
        if ([IO.Path]::GetDirectoryName($target) -eq $pluginRoot -and [IO.Path]::GetFileName($target).StartsWith('.runtime-prepare-')) {
            Remove-Item -LiteralPath $target -Recurse -Force
        }
    }
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
