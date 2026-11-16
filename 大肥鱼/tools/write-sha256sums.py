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
import zipfile
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


def package_info(file):
    """Read the package type and the internal version the ZIP was built with."""
    try:
        with zipfile.ZipFile(file) as archive:
            names = archive.namelist()
            markers = [name for name in names
                       if name == 'PACKAGE-TYPE.json' or name.endswith('/PACKAGE-TYPE.json')]
            if len(markers) != 1:
                raise SystemExit(
                    f'Release asset must contain exactly one PACKAGE-TYPE.json '
                    f'(found {len(markers)}): {file}')
            try:
                marker = json.loads(archive.read(markers[0]))
            except ValueError:
                raise SystemExit(f'Invalid PACKAGE-TYPE.json: {file}')
            if not isinstance(marker, dict) or not isinstance(marker.get('packageType'), str):
                raise SystemExit(f'Invalid PACKAGE-TYPE.json: {file}')
            marker_version = marker.get('version')
            if marker_version is not None and not isinstance(marker_version, str):
                raise SystemExit(f'Invalid version in PACKAGE-TYPE.json: {file}')
            # The package.json next to the marker is the authoritative build
            # version for both package types. package.py stamps it from --version
            # and package-source.py copies the source tree's package.json.
            prefix = markers[0][:-len('PACKAGE-TYPE.json')]
            manifest_name = prefix + 'package.json'
            manifest_version = None
            if manifest_name in names:
                try:
                    manifest = json.loads(archive.read(manifest_name))
                except ValueError:
                    raise SystemExit(f'Invalid package.json in release asset: {file}')
                if isinstance(manifest, dict) and isinstance(manifest.get('version'), str):
                    manifest_version = manifest['version']
            if marker_version is not None and manifest_version is not None \
                    and marker_version != manifest_version:
                raise SystemExit(
                    f'Package version metadata is inconsistent: {file} has '
                    f'PACKAGE-TYPE.json {marker_version} but package.json {manifest_version}.')
    except zipfile.BadZipFile:
        raise SystemExit(f'Release asset is not a readable ZIP: {file}')
    return {
        'packageType': marker['packageType'],
        'version': manifest_version if manifest_version is not None else marker_version,
    }


def require_package_type(info, file, expected, flag):
    if info['packageType'] != expected:
        raise SystemExit(
            f'Release asset type mismatch: {flag} expects a {expected} package but '
            f'{file} is a {info["packageType"]} package. Check that --complete and --source are not swapped.')


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
# The asset names are derived from the flags, so a swapped --complete/--source
# would publish the two hashes under each other's names. Verify the markers
# packaged next to each ZIP before writing anything.
complete_info = package_info(complete)
source_info = package_info(source)
require_package_type(complete_info, complete, 'complete', '--complete')
require_package_type(source_info, source, 'source', '--source')
# The file names carry --version, so it must be the version actually packaged;
# otherwise a release would advertise hashes for a differently built ZIP.
for info, file in ((complete_info, complete), (source_info, source)):
    if info['version'] is None:
        raise SystemExit(f'Cannot determine the internal version packaged in {file}; rebuild it with --version.')
    if info['version'] != version:
        raise SystemExit(
            f'Release asset version mismatch: {file} was built as {info["version"]} but '
            f'SHA256SUMS uses {version}. Rebuild the asset with --version {version} '
            f'or pass --version {info["version"]}.')
for file in (complete, source):
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
