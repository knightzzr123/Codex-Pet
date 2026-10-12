"""Create a GitHub source ZIP from Git's non-ignored project files."""
import argparse
import hashlib
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
with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise ValueError('Source ZIP CRC verification failed.')
    for name, source in files:
        expected = hashlib.sha256(source.read_bytes()).digest()
        if hashlib.sha256(archive.read('大肥鱼/' + name)).digest() != expected:
            raise ValueError('Source ZIP hash mismatch: ' + name)
print(f'{len(files)} source files, {sum(source.stat().st_size for _, source in files)} bytes before compression.')
print(output)
