"""One-time, isolated deployment. Does not configure a public reverse proxy.
Uses an interactive SSH password, pinned host key, and a separate Node runtime.
Requires local paramiko. Never stores the SSH password.
"""
import argparse
import getpass
import io
import json
from pathlib import Path
import secrets
import shlex
import tarfile
import uuid
import paramiko

parser = argparse.ArgumentParser()
parser.add_argument('--host', required=True)
parser.add_argument('--user', default='ubuntu')
parser.add_argument('--known-hosts', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
client = paramiko.SSHClient()
client.load_host_keys(args.known_hosts)
client.connect(args.host, username=args.user, password=getpass.getpass('SSH password: '), look_for_keys=False, allow_agent=False, timeout=15)

def run(command, stdin_text=None, timeout=180):
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    if stdin_text is not None:
        stdin.write(stdin_text)
        stdin.flush()
    stdin.channel.shutdown_write()
    output = stdout.read().decode('utf-8', 'replace')
    error = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    if code:
        raise RuntimeError(f'Remote command failed ({code}): {error[-1500:]} {output[-1500:]}')
    return output

stage = f'/home/{args.user}/.jianjian-stage-{uuid.uuid4().hex}.tar.gz'
try:
    run('test ! -e /opt/jianjian && test ! -e /etc/systemd/system/jianjian.service && sudo -n true')
    print('Creating an isolated deployment package...', flush=True)
    content = io.BytesIO()
    with tarfile.open(fileobj=content, mode='w:gz') as archive:
        for directory in ('server', 'web', 'tests', 'desktop'):
            for path in (root / directory).rglob('*'):
                if path.is_file():
                    archive.add(path, arcname=path.relative_to(root).as_posix())
        archive.add(root / 'package.json', arcname='package.json')
        service = (root / 'deploy/jianjian.service').read_text(encoding='utf-8').replace('/usr/bin/node', '/opt/jianjian/runtime/bin/node').encode()
        entry = tarfile.TarInfo('jianjian.service'); entry.size = len(service); entry.mode = 0o644
        archive.addfile(entry, io.BytesIO(service))
    content.seek(0)
    with client.open_sftp() as sftp:
        sftp.putfo(content, stage)
        sftp.chmod(stage, 0o600)
    run(f'sudo mkdir /opt/jianjian && sudo tar -xzf {shlex.quote(stage)} -C /opt/jianjian')
    print('Installing a private Node.js 24 runtime; system Node is unchanged...', flush=True)
    run(r"""set -eu
cd /opt/jianjian
sudo curl --connect-timeout 15 --max-time 120 -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o SHASUMS256.txt
NODE_ARCHIVE=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2}' SHASUMS256.txt)
test -n "$NODE_ARCHIVE"
sudo curl --connect-timeout 15 --max-time 180 -fsSL "https://nodejs.org/dist/latest-v24.x/$NODE_ARCHIVE" -o "$NODE_ARCHIVE"
grep "  $NODE_ARCHIVE$" SHASUMS256.txt | sha256sum -c -
sudo mkdir runtime
sudo tar -xJf "$NODE_ARCHIVE" -C runtime --strip-components=1
sudo chmod -R a+rX,go-w /opt/jianjian
getent passwd jianjian >/dev/null || sudo useradd --system --home /var/lib/jianjian --shell /usr/sbin/nologin jianjian
sudo install -d -o jianjian -g jianjian -m 700 /var/lib/jianjian
""", timeout=300)
    print('Running server and clipboard tests with the Linux runtime...', flush=True)
    print(run('cd /opt/jianjian && sudo -u jianjian /opt/jianjian/runtime/bin/node --test tests/*.test.mjs', timeout=120), flush=True)
    admin_password = secrets.token_urlsafe(24)
    credential_file = root / 'releases' / 'server-admin.local'
    if credential_file.exists():
        raise RuntimeError('A local bootstrap credential file already exists; refusing to replace it.')
    credential_file.write_text(json.dumps({'host': args.host, 'username': 'admin', 'password': admin_password, 'service': '127.0.0.1:8787', 'note': 'Initial application admin credentials. Public HTTPS endpoint is not configured.'}, ensure_ascii=False, indent=2), encoding='utf-8')
    run("sudo -u jianjian sh -c 'IFS= read -r JIANJIAN_ADMIN_PASSWORD; export JIANJIAN_ADMIN_PASSWORD; export DATA_DIR=/var/lib/jianjian; exec /opt/jianjian/runtime/bin/node /opt/jianjian/server/admin.mjs admin'", admin_password + '\n')
    print('Starting jianjian.service on loopback port 8787...', flush=True)
    print(run('sudo install -m 644 /opt/jianjian/jianjian.service /etc/systemd/system/jianjian.service && sudo systemctl daemon-reload && sudo systemctl enable --now jianjian && sudo systemctl is-active jianjian'), flush=True)
    print(run('curl --retry 5 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:8787/api/health && echo && /opt/jianjian/runtime/bin/node --version'), flush=True)
    print(f'Initial application admin credentials saved locally: {credential_file}', flush=True)
    print('Public ports and existing services were not modified.', flush=True)
finally:
    try:
        with client.open_sftp() as sftp:
            sftp.remove(stage)
    except OSError:
        pass
    client.close()
