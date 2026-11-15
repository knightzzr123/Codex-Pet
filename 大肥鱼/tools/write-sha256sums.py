"""Aggregate the complete and source release assets into one LF SHA256SUMS.

Each packaging script writes `<artifact>.sha256` next to its own artifact. This
step verifies those sidecars and writes the single GitHub Release SHA256SUMS,
using the documented asset names instead of the local build file names.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

parser = argparse.ArgumentParser()
parser.add_argument('--complete', type=Path, required=True, help='Complete installation ZIP.')
parser.add_argument('--source', type=Path, required=True, help='Source ZIP.')
parser.add_argument('--version', default=None, help='Internal version used in the release asset names.')
parser.add_argument('--output', type=Path, default=None, help='Combined SHA256SUMS path.')
args = parser.parse_args()


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def sidecar_hash(file):
    sidecar = file.with_name(file.name + '.sha256')
    if not sidecar.is_file():
        raise SystemExit(f'Missing sidecar checksum: {sidecar}')
    text = sidecar.read_text(encoding='utf-8').replace('\r\n', '\n').replace('\r', '\n')
    match = re.match(r'^([0-9a-f]{64})  (\S.*)$', text.split('\n')[0])
    if not match:
        raise SystemExit(f'Invalid sidecar checksum: {sidecar}')
    return match.group(1)


version = args.version
if version is None:
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
if not re.fullmatch(r'\d+\.\d+\.\d+', version):
    raise SystemExit(f'Invalid internal version: {version}')

complete = args.complete.resolve()
source = args.source.resolve()
for file in (complete, source):
    if not file.is_file():
        raise SystemExit(f'Release asset not found: {file}')
    if file.suffix.lower() != '.zip':
        raise SystemExit(f'Release asset must be a ZIP: {file}')
    if sidecar_hash(file) != digest(file):
        raise SystemExit(f'Sidecar checksum does not match: {file}')

assets = {
    f'dafeiyu-codex-pet-{version}-windows-x64.zip': digest(complete),
    f'dafeiyu-codex-pet-{version}-source.zip': digest(source),
}
lines = ''.join(f'{checksum}  {name}\n' for name, checksum in sorted(assets.items()))
output = (args.output or complete.parent / 'SHA256SUMS').resolve()
output.parent.mkdir(parents=True, exist_ok=True)
temporary = output.with_name(output.name + '.tmp')
temporary.write_bytes(lines.encode('utf-8'))
os.replace(temporary, output)
print(json.dumps({
    'output': str(output),
    'bytes': len(lines.encode('utf-8')),
    'assets': [{'name': name, 'sha256': checksum} for name, checksum in sorted(assets.items())],
}, ensure_ascii=False, indent=2))
