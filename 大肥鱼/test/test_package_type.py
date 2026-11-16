import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SCRIPT = ROOT / 'tools' / 'package-source.py'
PACKAGE_SCRIPT = ROOT / 'tools' / 'package.py'
SUMS_SCRIPT = ROOT / 'tools' / 'write-sha256sums.py'


class PackageTypeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.project = self.base / 'project'
        self.project.mkdir()
        payload = b'fake-runtime-payload'
        self.runtime = self.project / 'runtime.7z'
        self.runtime.write_bytes(payload)
        self.manifest = {'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}
        (self.project / 'runtime-manifest.json').write_text(json.dumps(self.manifest), encoding='utf-8')
        for name, value in {
            'plugin.json': {'version': '3.4.0'},
            '.codex-plugin/plugin.json': {'version': '3.4.0'},
            'package.json': {'version': '3.4.0'},
            'mcp.json': {'mcpServers': {'codex-pet': {'cwd': './', 'env': {'DAFEIYU_DESKTOP_ONLY': '1'}, 'args': []}}},
            '.mcp.json': {'mcpServers': {'codex-pet': {'cwd': './', 'env': {'DAFEIYU_DESKTOP_ONLY': '1'}, 'args': []}}},
        }.items():
            file = self.project / name; file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(json.dumps(value), encoding='utf-8')
        text_files = ['prepare-runtime.ps1', 'start-mcp.cmd', 'install.ps1', 'install.cmd', 'install-autostart.ps1', 'THIRD-PARTY-NOTICES.txt', 'README.md', 'src/launch-desktop-pet.ps1', 'src/codex-scope.ps1', 'src/plugin-server.cjs', '.agents/plugins/marketplace.json']
        for name in text_files:
            file = self.project / name; file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'\xef\xbb\xbffixture' if name.endswith('.ps1') else b'fixture')
        (self.project / 'assets').mkdir(); (self.project / 'licenses').mkdir()
        (self.project / 'tools/7zip').mkdir(parents=True); (self.project / 'test').mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def run_source(self, output):
        self.runtime.unlink(missing_ok=True)
        subprocess.run(['git', 'init', '-q', str(self.project)], check=True)
        subprocess.run(['git', '-C', str(self.project), 'add', '.'], check=True)
        return subprocess.run([sys.executable, str(SOURCE_SCRIPT), '--root', str(self.project), '--output', str(output)], text=True, capture_output=True)

    def run_package(self, output, runtime=None, original=None, version='3.4.0'):
        command = [sys.executable, str(PACKAGE_SCRIPT), '--root', str(self.project), '--output', str(output), '--verify-directory', str(self.base / ('verify-' + output.stem)), '--metadata-directory', str(self.base / 'metadata'), '--version', version]
        if runtime is not None:
            command += ['--runtime-archive', str(runtime)]
        if original is not None:
            command += ['--original', str(original)]
        return subprocess.run(command, text=True, capture_output=True)

    def run_sums(self, complete, source, output=None):
        command = [sys.executable, str(SUMS_SCRIPT), '--complete', str(complete),
                   '--source', str(source), '--version', '3.4.0',
                   '--output', str(output or (self.base / 'SHA256SUMS'))]
        return subprocess.run(command, text=True, capture_output=True)

    def write_sidecar(self, file):
        sidecar = file.with_name(file.name + '.sha256')
        sidecar.write_text(f'{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}\n',
                           encoding='utf-8', newline='\n')

    def build_both_packages(self, complete_name='complete.zip', source_name='source.zip',
                            directory=None, version='3.4.0'):
        directory = Path(directory or self.base)
        directory.mkdir(parents=True, exist_ok=True)
        complete = directory / complete_name
        source = directory / source_name
        packed = self.run_package(complete, runtime=self.runtime, version=version)
        self.assertEqual(packed.returncode, 0, packed.stderr + packed.stdout)
        sourced = self.run_source(source)
        self.assertEqual(sourced.returncode, 0, sourced.stderr)
        return complete, source

    def run_release_check(self, package, report=None):
        command = ['node', str(ROOT / 'tools' / 'release-check.cjs'), '--package', str(package)]
        if report is not None:
            command += ['--report', str(report)]
        return subprocess.run(command, text=True, capture_output=True)

    def test_source_package_has_source_marker_and_no_runtime(self):
        output = self.base / 'source.zip'
        result = self.run_source(output)
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(output) as archive:
            names = archive.namelist()
            marker = json.loads(archive.read('大肥鱼/PACKAGE-TYPE.json'))
            self.assertEqual(marker['packageType'], 'source')
            self.assertFalse(marker['installable'])
            self.assertFalse(any(name.endswith('/runtime.7z') or '/runtime/' in name for name in names))
        sidecar = self.base / 'source.zip.sha256'
        self.assertTrue(sidecar.is_file())
        raw = sidecar.read_bytes()
        self.assertNotIn(b'\r', raw)
        self.assertEqual(raw, (hashlib.sha256(output.read_bytes()).hexdigest() + '  source.zip\n').encode('utf-8'))
        self.assertFalse((self.base / 'SHA256SUMS').exists())

    def test_complete_package_has_verified_runtime_and_report(self):
        output = self.base / 'complete.zip'
        result = self.run_package(output, runtime=self.runtime)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        with zipfile.ZipFile(output) as archive:
            marker = json.loads(archive.read('大肥鱼/PACKAGE-TYPE.json'))
            self.assertEqual(marker['packageType'], 'complete')
            self.assertEqual(archive.read('大肥鱼/runtime.7z'), self.runtime.read_bytes())
        report = json.loads((self.base / 'metadata/complete.validation.json').read_text(encoding='utf-8'))
        self.assertEqual(report['packageType'], 'complete')
        sidecar = self.base / 'complete.zip.sha256'
        self.assertTrue(sidecar.is_file())
        self.assertEqual(sidecar.read_bytes(),
                         (report['sha256'] + '  complete.zip\n').encode('utf-8'))
        self.assertNotIn(b'\r', sidecar.read_bytes())
        self.assertTrue((self.base / 'metadata/complete.zip.sha256').is_file())
        self.assertFalse((self.base / 'SHA256SUMS').exists())
        self.assertFalse((self.base / 'metadata/SHA256SUMS').exists())

    def test_runtime_size_or_hash_mismatch_fails(self):
        self.manifest['sha256'] = '0' * 64
        (self.project / 'runtime-manifest.json').write_text(json.dumps(self.manifest), encoding='utf-8')
        result = self.run_package(self.base / 'mismatch.zip', runtime=self.runtime)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('does not match manifest', result.stderr)

    def test_runtime_size_mismatch_fails(self):
        self.manifest['bytes'] += 1
        (self.project / 'runtime-manifest.json').write_text(json.dumps(self.manifest), encoding='utf-8')
        result = self.run_package(self.base / 'wrong-size.zip', runtime=self.runtime)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('size does not match manifest', result.stderr)

    def test_source_packaging_rejects_runtime_asset_in_git_file_list(self):
        output = self.base / 'with-runtime.zip'
        result = self.run_source(output)
        self.assertEqual(result.returncode, 0, result.stderr)
        (self.project / 'runtime.7z').write_bytes(b'forbidden')
        subprocess.run(['git', '-C', str(self.project), 'add', 'runtime.7z'], check=True)
        second = subprocess.run([sys.executable, str(SOURCE_SCRIPT), '--root', str(self.project), '--output', str(self.base / 'reject.zip')], text=True, capture_output=True)
        self.assertNotEqual(second.returncode, 0)
        self.assertIn('refuses runtime assets', second.stderr)

    def test_source_packaging_rejects_complete_marker(self):
        output = self.base / 'source-with-complete-marker.zip'
        self.assertEqual(self.run_source(output).returncode, 0)
        marker = self.project / 'PACKAGE-TYPE.json'
        marker.write_text(json.dumps({'packageType': 'complete'}), encoding='utf-8')
        subprocess.run(['git', '-C', str(self.project), 'add', 'PACKAGE-TYPE.json'], check=True)
        result = subprocess.run([sys.executable, str(SOURCE_SCRIPT), '--root', str(self.project), '--output', str(self.base / 'reject-marker.zip')], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('complete package type marker', result.stderr)

    def test_source_zip_cannot_be_used_as_original(self):
        source = self.base / 'source.zip'
        self.assertEqual(self.run_source(source).returncode, 0)
        result = self.run_package(self.base / 'from-source.zip', original=source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('source package', result.stderr)

    def test_package_py_default_version_is_3_4_0_and_does_not_clobber_sums(self):
        output = self.base / 'default-version.zip'
        command = [sys.executable, str(PACKAGE_SCRIPT), '--root', str(self.project), '--output', str(output), '--verify-directory', str(self.base / 'verify-default-version'), '--metadata-directory', str(self.base / 'metadata'), '--runtime-archive', str(self.runtime)]
        stale = self.base / 'SHA256SUMS'
        stale_lines = (f'{"a" * 64}  dafeiyu-codex-pet-3.4.0-windows-x64.zip\r\n'
                       f'{"b" * 64}  dafeiyu-codex-pet-3.4.0-source.zip\r\n')
        stale.write_bytes(stale_lines.encode('utf-8'))
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = json.loads((self.base / 'metadata/default-version.validation.json').read_text(encoding='utf-8'))
        self.assertEqual(report['version'], '3.4.0')
        with zipfile.ZipFile(output) as archive:
            metadata = json.loads(archive.read('大肥鱼/package.json'))
            marker = json.loads(archive.read('大肥鱼/PACKAGE-TYPE.json'))
        self.assertEqual(metadata['version'], '3.4.0')
        self.assertEqual(marker['version'], '3.4.0')
        self.assertEqual(stale.read_bytes(), stale_lines.encode('utf-8'),
                         'package.py must not overwrite the aggregated SHA256SUMS')
        raw = (self.base / 'default-version.zip.sha256').read_bytes()
        self.assertNotIn(b'\r', raw)
        self.assertTrue(raw.endswith(b'\n'))
        self.assertEqual(raw.count(b'\n'), 1)
        self.assertEqual(raw, (report['sha256'] + '  default-version.zip\n').encode('utf-8'))
        self.assertTrue((self.base / 'metadata' / 'default-version.zip.sha256').is_file())
        self.assertFalse((self.base / 'metadata' / 'SHA256SUMS').exists())

    def test_write_sha256sums_rejects_a_package_version_mismatch(self):
        # The asset file names carry --version, so a package built as 3.3.2 must
        # not be published under 3.4.0 names.
        for name in ('plugin.json', '.codex-plugin/plugin.json', 'package.json'):
            file = self.project / name
            value = json.loads(file.read_text(encoding='utf-8'))
            value['version'] = '3.3.2'
            file.write_text(json.dumps(value), encoding='utf-8')
        complete, source = self.build_both_packages(version='3.3.2')
        output = self.base / 'release' / 'SHA256SUMS'
        result = self.run_sums(complete, source, output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('version mismatch', result.stderr)
        self.assertIn('3.3.2', result.stderr)
        self.assertIn('3.4.0', result.stderr)
        self.assertFalse(output.exists())

    def test_write_sha256sums_aggregates_both_assets_with_final_names(self):
        complete = self.base / 'complete.zip'
        source = self.base / 'source.zip'
        packed = self.run_package(complete, runtime=self.runtime)
        self.assertEqual(packed.returncode, 0, packed.stderr + packed.stdout)
        sourced = self.run_source(source)
        self.assertEqual(sourced.returncode, 0, sourced.stderr)
        output = self.base / 'release' / 'SHA256SUMS'
        command = [sys.executable, str(SUMS_SCRIPT), '--complete', str(complete), '--source', str(source),
                   '--version', '3.4.0', '--output', str(output)]
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        raw = output.read_bytes()
        self.assertNotIn(b'\r', raw)
        lines = raw.decode('utf-8').splitlines()
        self.assertEqual(len(lines), 2)
        expected = {
            'dafeiyu-codex-pet-3.4.0-windows-x64.zip': hashlib.sha256(complete.read_bytes()).hexdigest(),
            'dafeiyu-codex-pet-3.4.0-source.zip': hashlib.sha256(source.read_bytes()).hexdigest(),
        }
        for line in lines:
            checksum, name = line.split('  ', 1)
            self.assertEqual(expected[name], checksum)
        # Re-running replaces the file atomically instead of appending.
        again = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(output.read_bytes(), raw)
        # A stale or tampered sidecar must be rejected.
        (source.parent / (source.name + '.sha256')).write_text(
            f'{"0" * 64}  {source.name}\n', encoding='utf-8', newline='\n')
        mismatch = subprocess.run(command, text=True, capture_output=True)
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertIn('does not match', mismatch.stderr)

    def test_write_sha256sums_rejects_swapped_complete_and_source(self):
        complete, source = self.build_both_packages()
        output = self.base / 'release' / 'SHA256SUMS'
        swapped = self.run_sums(source, complete, output)
        self.assertNotEqual(swapped.returncode, 0)
        self.assertIn('type mismatch', swapped.stderr)
        self.assertIn('--complete', swapped.stderr)
        self.assertIn('source package', swapped.stderr)
        self.assertFalse(output.exists())

        both_complete = self.run_sums(complete, complete, output)
        self.assertNotEqual(both_complete.returncode, 0)
        self.assertIn('--source', both_complete.stderr)
        self.assertIn('complete package', both_complete.stderr)
        self.assertFalse(output.exists())

        both_source = self.run_sums(source, source, output)
        self.assertNotEqual(both_source.returncode, 0)
        self.assertIn('--complete', both_source.stderr)
        self.assertFalse(output.exists())

    def test_write_sha256sums_requires_a_package_type_marker(self):
        _, source = self.build_both_packages()
        bare = self.base / 'bare.zip'
        with zipfile.ZipFile(bare, 'w') as archive:
            archive.writestr('大肥鱼/package.json', '{}')
        self.write_sidecar(bare)
        output = self.base / 'release' / 'SHA256SUMS'
        result = self.run_sums(bare, source, output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exactly one PACKAGE-TYPE.json', result.stderr)
        self.assertFalse(output.exists())

    def test_write_sha256sums_rejects_unreadable_or_invalid_marker(self):
        _, source = self.build_both_packages()
        output = self.base / 'release' / 'SHA256SUMS'

        broken = self.base / 'broken.zip'
        broken.write_bytes(b'not a zip')
        self.write_sidecar(broken)
        result = self.run_sums(broken, source, output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not a readable ZIP', result.stderr)

        invalid = self.base / 'invalid.zip'
        with zipfile.ZipFile(invalid, 'w') as archive:
            archive.writestr('大肥鱼/PACKAGE-TYPE.json', 'not json')
        self.write_sidecar(invalid)
        result = self.run_sums(invalid, source, output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Invalid PACKAGE-TYPE.json', result.stderr)
        self.assertFalse(output.exists())

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for release-check')
    def test_documented_release_order_passes_release_check(self):
        complete_name = 'dafeiyu-codex-pet-3.4.0-windows-x64.zip'
        source_name = 'dafeiyu-codex-pet-3.4.0-source.zip'
        release = self.base / 'release'
        complete, source = self.build_both_packages(complete_name, source_name, release, version='3.4.0')
        with zipfile.ZipFile(complete) as archive:
            archive.extractall(release)
        package = release / '大肥鱼'
        # README order: check the unpacked package first (no SHA256SUMS yet),
        # then aggregate next to the official asset names, then check again.
        first = self.run_release_check(package)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertIn('"ok": true', first.stdout)
        self.assertFalse((release / 'SHA256SUMS').exists())

        sums = self.run_sums(complete, source, release / 'SHA256SUMS')
        self.assertEqual(sums.returncode, 0, sums.stderr + sums.stdout)
        self.assertEqual(sorted(path.name for path in release.glob('dafeiyu-*.zip')),
                         sorted([complete_name, source_name]))
        self.assertEqual((release / 'SHA256SUMS').read_bytes().count(b'\n'), 2)
        self.assertNotIn(b'\r', (release / 'SHA256SUMS').read_bytes())

        report = release / 'report.json'
        second = self.run_release_check(package, report)
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn('"ok": true', second.stdout)
        parsed = json.loads(report.read_text(encoding='utf-8'))
        self.assertEqual(parsed['sha256sums']['checked'], True)
        self.assertEqual(parsed['sha256sums']['verified'], 2)
        self.assertEqual(parsed['sha256sums']['errors'], [])


if __name__ == '__main__':
    unittest.main()
