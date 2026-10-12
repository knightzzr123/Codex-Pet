"""Build a portable release from explicit source paths and the original runtime payload."""
import argparse
import contextlib
import hashlib
import json
import shutil
import time
import zipfile
from pathlib import Path, PureWindowsPath

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
runtime_source = parser.add_mutually_exclusive_group()
runtime_source.add_argument('--original', type=Path, help='Read runtime.7z from an existing complete installation ZIP.')
runtime_source.add_argument('--runtime-archive', type=Path, help='Use a standalone verified runtime.7z.')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--verify-directory', type=Path)
parser.add_argument('--metadata-directory', type=Path)
parser.add_argument('--version', default='3.3.2')
args = parser.parse_args()
root = args.root.resolve()
output = args.output.resolve()
verify = (args.verify_directory or root / 'work' / ('package-check-' + str(time.time_ns()))).resolve()
metadata_directory = (args.metadata_directory or root / 'work' / 'release-reports').resolve()
if output.exists() or verify.exists():
    raise SystemExit('Release output and verification directory must be new.')
if args.original:
    if not args.original.is_file():
        raise SystemExit('Input installation ZIP not found.')
elif not (args.runtime_archive or root / 'runtime.7z').is_file():
    raise SystemExit('Provide --original with a complete installation ZIP, or --runtime-archive with runtime.7z.')
output.parent.mkdir(parents=True, exist_ok=True)
verify.mkdir(parents=True)
manifest = json.loads((root / 'runtime-manifest.json').read_text(encoding='utf-8-sig'))
prefix = '大肥鱼/'
hashes = {}
copied_sources = {}

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def add_bytes(archive, relative, value, stored=False):
    archive.writestr(prefix + relative, value,
                     compress_type=zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED,
                     compresslevel=None if stored else 9)
    hashes[relative] = hashlib.sha256(value).hexdigest()

readme = (root / 'README.md').read_text(encoding='utf-8-sig')

root_files = ['plugin.json', 'package.json', 'mcp.json', '.mcp.json',
              'runtime-manifest.json', 'prepare-runtime.ps1', 'start-mcp.cmd',
              'install.ps1', 'install.cmd', 'install-autostart.ps1',
              'THIRD-PARTY-NOTICES.txt']
directories = ['.codex-plugin', '.agents', 'src', 'assets', 'licenses', 'tools/7zip', 'test']
files = [root / name for name in root_files]
for directory in directories:
    files.extend(file for file in (root / directory).rglob('*') if file.is_file())

with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as release:
    for source in sorted(set(files)):
        relative = source.relative_to(root).as_posix()
        if source.is_symlink():
            raise ValueError('Symlinks are not supported in this release.')
        value = source.read_bytes()
        copied_sources[relative] = hashlib.sha256(value).hexdigest()
        if relative in ('plugin.json', '.codex-plugin/plugin.json', 'package.json'):
            metadata = json.loads(value.decode('utf-8-sig'))
            metadata['version'] = args.version
            value = (json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        add_bytes(release, relative, value)
    add_bytes(release, 'README.md', readme.encode('utf-8'))
    add_bytes(release, '安装大肥鱼.cmd', (root / 'install.cmd').read_bytes())
    with contextlib.ExitStack() as stack:
        if args.original:
            original = stack.enter_context(zipfile.ZipFile(args.original))
            candidates = [entry for entry in original.infolist() if entry.filename.endswith('/runtime.7z') or entry.filename == 'runtime.7z']
            if len(candidates) != 1:
                raise ValueError('Input ZIP must contain one runtime archive.')
            entry = candidates[0]
            payload_bytes = entry.file_size
            payload = stack.enter_context(original.open(entry))
        else:
            runtime_archive = args.runtime_archive or root / 'runtime.7z'
            if not runtime_archive.is_file():
                raise ValueError('Provide --original with a complete installation ZIP, or --runtime-archive with runtime.7z.')
            payload_bytes = runtime_archive.stat().st_size
            payload = stack.enter_context(runtime_archive.open('rb'))
        if payload_bytes != manifest['bytes']:
            raise ValueError('Runtime payload size does not match manifest.')
        checksum = hashlib.sha256()
        with release.open(prefix + 'runtime.7z', 'w') as dst:
            while chunk := payload.read(1024 * 1024):
                checksum.update(chunk)
                dst.write(chunk)
        if checksum.hexdigest() != manifest['sha256']:
            raise ValueError('Original runtime payload does not match manifest.')
        hashes['runtime.7z'] = checksum.hexdigest()
    checksums = ''.join(f'{checksum}  {name}\n' for name, checksum in sorted(hashes.items()))
    add_bytes(release, 'FILES.sha256', checksums.encode('utf-8'))

if output.stat().st_size >= 100_000_000:
    raise ValueError('Release exceeds the 100 MB distribution size target.')
with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise ValueError('ZIP CRC verification failed.')
    names = archive.namelist()
    if len(names) != len(set(names)) or any(not name.startswith(prefix) for name in names):
        raise ValueError('Invalid release root or duplicate ZIP entries.')
    for entry in archive.infolist():
        target = (verify / entry.filename).resolve()
        if not target.is_relative_to(verify) or '..' in Path(entry.filename).parts:
            raise ValueError('Invalid ZIP extraction path.')
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(entry) as src, target.open('xb') as dst:
            shutil.copyfileobj(src, dst)
        if digest(target) != hashes[entry.filename[len(prefix):]]:
            raise ValueError('Extracted file hash does not match.')

package = verify / '大肥鱼'
for relative in ('plugin.json', '.codex-plugin/plugin.json', 'package.json'):
    if json.loads((package / relative).read_text(encoding='utf-8'))['version'] != args.version:
        raise ValueError('Version metadata is inconsistent.')
for relative in ('mcp.json', '.mcp.json'):
    value = json.loads((package / relative).read_text(encoding='utf-8'))
    server = value['mcpServers']['codex-pet']
    if server['cwd'] != './' or server['env']['DAFEIYU_DESKTOP_ONLY'] != '1':
        raise ValueError('Non-portable MCP launch settings.')
    if any(PureWindowsPath(item).is_absolute() for item in server['args']):
        raise ValueError('Machine-specific MCP argument.')
for relative in ('src/launch-desktop-pet.ps1', 'src/codex-scope.ps1', 'install-autostart.ps1'):
    if not (package / relative).read_bytes().startswith(b'\xef\xbb\xbf'):
        raise ValueError('PowerShell UTF-8 BOM is missing.')

checksum = digest(output)
metadata_directory.mkdir(parents=True, exist_ok=True)
(metadata_directory / (output.name + '.sha256')).write_text(f'{checksum}  {output.name}\n', encoding='utf-8')
report = {
    'version': args.version, 'archive': str(output), 'bytes': output.stat().st_size,
    'sha256': checksum, 'files': len(hashes), 'zipCrcVerified': True,
    'extractedHashesVerified': True, 'portableMcp': True, 'verifiedDirectory': str(package),
    'runtimeSha256': manifest['sha256'], 'copiedSources': copied_sources,
}
(metadata_directory / (output.stem + '.validation.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({key: value for key, value in report.items() if key != 'copiedSources'}, ensure_ascii=False))
