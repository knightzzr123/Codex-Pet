import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SCRIPT = ROOT / 'tools' / 'package-source.py'
PACKAGE_SCRIPT = ROOT / 'tools' / 'package.py'


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
            'plugin.json': {'version': '3.3.2'},
            '.codex-plugin/plugin.json': {'version': '3.3.2'},
            'package.json': {'version': '3.3.2'},
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

    def run_package(self, output, runtime=None, original=None):
        command = [sys.executable, str(PACKAGE_SCRIPT), '--root', str(self.project), '--output', str(output), '--verify-directory', str(self.base / ('verify-' + output.stem)), '--metadata-directory', str(self.base / 'metadata'), '--version', '3.3.2']
        if runtime is not None:
            command += ['--runtime-archive', str(runtime)]
        if original is not None:
            command += ['--original', str(original)]
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

    def test_package_py_default_version_is_3_3_1(self):
        output = self.base / 'default-version.zip'
        command = [sys.executable, str(PACKAGE_SCRIPT), '--root', str(self.project), '--output', str(output), '--verify-directory', str(self.base / 'verify-default-version'), '--metadata-directory', str(self.base / 'metadata'), '--runtime-archive', str(self.runtime)]
        stale = self.base / 'SHA256SUMS'
        stale.write_bytes(b'deadbeef  stale-release.zip\r\n')
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = json.loads((self.base / 'metadata/default-version.validation.json').read_text(encoding='utf-8'))
        self.assertEqual(report['version'], '3.4.0')
        with zipfile.ZipFile(output) as archive:
            metadata = json.loads(archive.read('大肥鱼/package.json'))
            marker = json.loads(archive.read('大肥鱼/PACKAGE-TYPE.json'))
        self.assertEqual(metadata['version'], '3.4.0')
        self.assertEqual(marker['version'], '3.4.0')
        raw = stale.read_bytes()
        self.assertNotIn(b'\r', raw)
        self.assertTrue(raw.endswith(b'\n'))
        self.assertEqual(raw.count(b'\n'), 1)
        self.assertIn(output.name.encode('utf-8'), raw)
        self.assertNotIn(b'stale-release.zip', raw)
        self.assertEqual((self.base / 'metadata' / 'SHA256SUMS').read_bytes().splitlines()[0].split()[0].decode('ascii'), report['sha256'])



if __name__ == '__main__':
    unittest.main()
