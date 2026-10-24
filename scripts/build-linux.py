"""Build Linux desktop artifacts on an authorized SSH host in a fresh staging directory."""
import argparse
import getpass
import json
import posixpath
import re
import shlex
import time
import uuid
from pathlib import Path
import paramiko

parser = argparse.ArgumentParser()
parser.add_argument('--host', required=True)
parser.add_argument('--user', default='ubuntu')
parser.add_argument('--known-hosts', required=True)
parser.add_argument('--stage', help='Reuse an existing task-created build directory')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
ssh = paramiko.SSHClient(); ssh.load_host_keys(args.known_hosts)
ssh.connect(args.host, username=args.user, password=getpass.getpass('SSH password: '), allow_agent=False, look_for_keys=False, timeout=15)
stage = args.stage or f'/home/{args.user}/jianjian-build-{uuid.uuid4().hex[:10]}'
if not re.fullmatch(r'/home/' + re.escape(args.user) + r'/jianjian-build-[a-f0-9]{10}', stage):
    raise ValueError('Invalid build staging directory')
try:
    _, out, err = ssh.exec_command(f'test -d {shlex.quote(stage)}' if args.stage else f'mkdir -m 700 {shlex.quote(stage)}')
    if out.channel.recv_exit_status() != 0: raise RuntimeError(err.read().decode())
    with ssh.open_sftp() as sftp:
        for folder in ('desktop', 'web'):
            if not args.stage: sftp.mkdir(posixpath.join(stage, folder))
            for path in (root / folder).iterdir():
                if path.is_file(): sftp.put(str(path), posixpath.join(stage, folder, path.name))
        for name in ('package.json', 'package-lock.json'):
            sftp.put(str(root / name), posixpath.join(stage, name))
    command = f"""set -eu
export PATH=/opt/jianjian/runtime/bin:$PATH
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
cd {shlex.quote(stage)}
if test ! -d node_modules; then npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000; fi
node node_modules/electron/install.js
npm run build:linux
"""
    channel = ssh.get_transport().open_session(); channel.exec_command(command)
    while not channel.exit_status_ready():
        if channel.recv_ready(): print(channel.recv(8192).decode('utf-8', 'replace'), end='', flush=True)
        if channel.recv_stderr_ready(): print(channel.recv_stderr(8192).decode('utf-8', 'replace'), end='', flush=True)
        time.sleep(0.2)
    while channel.recv_ready(): print(channel.recv(8192).decode('utf-8', 'replace'), end='', flush=True)
    while channel.recv_stderr_ready(): print(channel.recv_stderr(8192).decode('utf-8', 'replace'), end='', flush=True)
    code = channel.recv_exit_status()
    if code: raise RuntimeError(f'Linux build failed ({code}); stage preserved at {stage}')
    with ssh.open_sftp() as sftp:
        for entry in sftp.listdir(posixpath.join(stage, 'releases')):
            if f'-{version}' in entry and entry.endswith(('.AppImage', '.deb')):
                dest = root / 'releases' / (f'Jianjian-{version}-Linux.AppImage' if entry.endswith('.AppImage') else f'Jianjian-{version}-Linux-amd64.deb')
                sftp.get(posixpath.join(stage, 'releases', entry), str(dest)); print(f'Downloaded {dest.name}', flush=True)
    print(f'Build staging directory: {stage}', flush=True)
finally:
    ssh.close()
