"""Create a GitHub source ZIP from Git's non-ignored project files."""
import argparse
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
parser.add_argument('--output', type=Path)
args = parser.parse_args()
root = args.root.resolve()
output = (args.output or root.parent / '大肥鱼-GitHub源码.zip').resolve()
if output.exists():
    raise SystemExit('Output already exists; select a new source ZIP path.')
result = subprocess.run(
    ['git', '-C', str(root), 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    check=True, capture_output=True,
)
names = sorted(set(name for name in result.stdout.decode('utf-8').split('\0') if name))
if not names:
    raise SystemExit('No source files found. Initialize the local Git repository first.')
files = []
excluded_directories = {'runtime', 'node_modules', 'work', 'dist', 'data', 'unused', '.git', '.codex'}
for name in names:
    relative = Path(name)
    if name == 'PACKAGE-TYPE.json':
        try:
            marker = json.loads((root / relative).read_text(encoding='utf-8'))
        except (OSError, ValueError):
            raise SystemExit('Invalid PACKAGE-TYPE.json in source tree.')
        if marker.get('packageType') == 'complete':
            raise SystemExit('Source packaging refuses a complete package type marker.')
        continue
    if relative.name == 'runtime.7z' or 'runtime' in relative.parts:
        raise SystemExit('Source packaging refuses runtime assets: ' + name)
    if relative.is_absolute() or '..' in relative.parts or relative.parts[0] in excluded_directories:
        raise ValueError('Generated files must not be tracked: ' + name)
    source = root / relative
    if source.is_symlink() or not source.resolve().is_relative_to(root):
        raise ValueError('Source path leaves the project: ' + name)
    if not source.is_file():
        raise ValueError('Missing source file: ' + name)
    if source.stat().st_size > 25 * 1024 * 1024:
        raise ValueError('Source file exceeds GitHub browser upload limit: ' + name)
    files.append((name, source))
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, source in files:
        archive.write(source, '大肥鱼/' + name)
    marker = {
        'packageType': 'source', 'installable': False,
        'warning': '源码包不包含运行时，不能作为完整安装包直接安装。',
    }
    archive.writestr('大肥鱼/PACKAGE-TYPE.json', json.dumps(marker, ensure_ascii=False, indent=2) + '\n')
with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise ValueError('Source ZIP CRC verification failed.')
    for name, source in files:
        expected = hashlib.sha256(source.read_bytes()).digest()
        if hashlib.sha256(archive.read('大肥鱼/' + name)).digest() != expected:
            raise ValueError('Source ZIP hash mismatch: ' + name)
    if any(entry.filename == '大肥鱼/runtime.7z' or '/runtime/' in entry.filename for entry in archive.infolist()):
        raise ValueError('Source ZIP must not contain runtime assets.')
    if json.loads(archive.read('大肥鱼/PACKAGE-TYPE.json'))['packageType'] != 'source':
        raise ValueError('Source ZIP package type marker is invalid.')
print(f'source package: {len(files)} files, {sum(source.stat().st_size for _, source in files)} bytes before compression.')
digest = hashlib.sha256(output.read_bytes()).hexdigest()
sums_path = output.parent / (output.name + '.sha256')
sums_path.write_text(f'{digest}  {output.name}\n', encoding='utf-8', newline='\n')
print(output)
