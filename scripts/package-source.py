"""Package source and checksum completed artifacts without including local credentials."""
import hashlib
import json
from pathlib import Path
import zipfile
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--platform', choices=['all', 'windows'], default='all', help='Artifacts required for this release')
args = parser.parse_args()

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
releases = root / 'releases'
releases.mkdir(exist_ok=True)
files = [root / name for name in ['package.json', 'package-lock.json', 'README.md', '.gitignore', '.dockerignore']]
for folder in ['web', 'desktop', 'server', 'tests', 'deploy', 'docs', 'scripts', '.github', 'android', 'mv']:
    for path in (root / folder).rglob('*'):
        relative = path.relative_to(root)
        if not path.is_file() or set(relative.parts) & {'build', '.gradle', '__pycache__'}: continue
        if path.name == 'local.properties' or path.suffix in {'.pyc', '.local', '.keystore', '.jks', '.log'}: continue
        files.append(path)
archive_path = releases / f'Jianjian-{version}-Source.zip'
with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(set(files)):
        archive.write(path, path.relative_to(root).as_posix())
with zipfile.ZipFile(archive_path) as archive:
    assert archive.testzip() is None
names = [f'Jianjian-{version}-Setup.exe', f'Jianjian-{version}-Windows.exe', archive_path.name]
if args.platform == 'all':
    names += [f'Jianjian-{version}-Android-debug.apk', f'Jianjian-{version}-Linux.AppImage']
checksums = []
for name in names:
    path = releases / name
    if not path.is_file(): raise RuntimeError(f'Missing release artifact: {name}')
    if path.stat().st_size == 0: raise RuntimeError(f'Empty release artifact: {name}')
    with path.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    checksums.append(digest + '  ' + name)
(releases / f'SHA256SUMS-{version}.txt').write_text('\n'.join(checksums) + '\n', encoding='utf-8')
print(f'Packaged {len(files)} source files and checksummed {len(names)} artifacts for {version}.')
