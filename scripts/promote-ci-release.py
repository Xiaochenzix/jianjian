"""Promote an already successful, same-repository build to an existing Release."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile

repo = os.environ['GITHUB_REPOSITORY']
run_id = os.environ['BUILD_RUN_ID']
tag = os.environ['RELEASE_TAG']
assert run_id.isdigit() and re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', tag)
version = tag[1:]
headers = {'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'User-Agent': 'Jianjian-release-promotion', 'Accept': 'application/vnd.github+json'}
base = 'https://api.github.com/repos/' + repo

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

opener = urllib.request.build_opener(NoRedirect())
def api(path, method='GET', body=None):
    request = urllib.request.Request(base + path, method=method, headers={**headers, **({'Content-Type': 'application/json'} if body is not None else {})}, data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response) if response.status != 204 else None

def download(path):
    request = urllib.request.Request(base + path, headers=headers)
    try:
        response = opener.open(request, timeout=90)
    except urllib.error.HTTPError as error:
        if error.code != 302:
            raise
        location = error.headers['Location']
        assert urllib.parse.urlparse(location).scheme == 'https'
        # Signed storage URL: do not forward the GitHub token to another host.
        response = urllib.request.urlopen(location, timeout=180)
    with response:
        return response.read()

def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()

run = api('/actions/runs/' + run_id)
assert run['status'] == 'completed' and run['conclusion'] == 'success', 'Build has not succeeded'
assert run['head_repository']['full_name'] == repo and run['path'] == '.github/workflows/build.yml'
sha = run['head_sha']
release = api('/releases/tags/' + tag)
assert not release['draft']
tag_path = '/git/refs/tags/' + urllib.parse.quote(tag, safe='')
original_tag_sha = api('/git/ref/tags/' + urllib.parse.quote(tag, safe=''))['object']['sha']
artifacts = {item['name']: item for item in api('/actions/runs/' + run_id + '/artifacts')['artifacts']}
expected = {'jianjian-windows-latest', 'jianjian-macos-latest', 'jianjian-ubuntu-latest', 'jianjian-android-debug'}
assert expected.issubset(artifacts) and all(not artifacts[name]['expired'] for name in expected)
output = {}
for name in sorted(expected):
    item = artifacts[name]
    data = download('/actions/artifacts/' + str(item['id']) + '/zip')
    assert digest(data) == item['digest'], 'Artifact digest mismatch: ' + name
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        candidates = [p for p in archive.namelist() if p.endswith(('.exe', '.dmg', '.AppImage', '.apk'))]
        if name == 'jianjian-windows-latest':
            desired = {f'Jianjian-{version}-Setup.exe', f'Jianjian-{version}-Windows.exe'}
            assert len(candidates) == 2 and {Path(p).name for p in candidates} == desired
            for path in candidates:
                output[Path(path).name] = archive.read(path)
        else:
            assert len(candidates) == 1, (name, candidates)
            path = candidates[0]
            if name == 'jianjian-macos-latest':
                assert 'arm64' in Path(path).name, 'Review architecture before labeling this DMG'
                target = f'Jianjian-{version}-macOS-arm64.dmg'
            elif name == 'jianjian-ubuntu-latest':
                target = f'Jianjian-{version}-Linux-x64.AppImage'
            else:
                target = 'Jianjian-0.4.0-Android-CI-debug.apk'
            output[target] = archive.read(path)
    print('Verified artifact:', name, flush=True)

# Source archive is pinned to exactly the commit used for the successful build.
source = download('/zipball/' + sha)
with zipfile.ZipFile(io.BytesIO(source)) as archive:
    names = [name for name in archive.namelist() if not name.endswith('/')]
    prefix = names[0].split('/')[0] + '/'
    package = json.loads(archive.read(prefix + 'package.json'))
    android_config = archive.read(prefix + 'android/app/build.gradle').decode()
    assert package['version'] == version and "versionName '0.4.0'" in android_config
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED) as clean:
        for name in names:
            assert name.startswith(prefix)
            clean.writestr(name[len(prefix):], archive.read(name))
    output[f'Jianjian-{version}-Source.zip'] = result.getvalue()

existing = {asset['name']: asset for asset in release['assets']}
# Keep the original locally signed APK: CI's ephemeral debug key cannot upgrade it.
compatible = existing.get('Jianjian-0.4.0-Android-debug.apk')
assert compatible and compatible.get('digest'), 'Compatible Android package missing'
checksums = {name: digest(data) for name, data in output.items()}
checksums[compatible['name']] = compatible['digest']
output[f'SHA256SUMS-{version}.txt'] = ''.join(value.removeprefix('sha256:') + '  ' + name + '\n' for name, value in sorted(checksums.items())).encode()
upload_base = release['upload_url'].split('{')[0]
assert urllib.parse.urlparse(upload_base).hostname == 'uploads.github.com'
prepared = []
for name, data in output.items():
    if name in existing and existing[name].get('digest') == digest(data):
        continue
    pending = f'pending-{run_id}-{name}'
    current = {asset['name']: asset for asset in api('/releases/' + str(release['id']))['assets']}
    asset = current.get(pending)
    if asset:
        assert asset.get('digest') == digest(data)
    else:
        request = urllib.request.Request(upload_base + '?name=' + urllib.parse.quote(pending), data=data, headers={**headers, 'Content-Type': 'application/octet-stream'}, method='POST')
        with urllib.request.urlopen(request, timeout=300) as response:
            asset = json.load(response)
    assert asset['size'] == len(data) and asset['digest'] == digest(data)
    prepared.append((name, asset))
    print('Staged release asset:', name, flush=True)

# Only replace public assets after every upload has passed integrity checks.
assert api('/git/ref/tags/' + urllib.parse.quote(tag, safe=''))['object']['sha'] == original_tag_sha, 'Release tag changed during promotion'
api(tag_path, 'PATCH', {'sha': sha, 'force': True})
for name, asset in prepared:
    if name in existing:
        api('/releases/assets/' + str(existing[name]['id']), 'DELETE')
    api('/releases/assets/' + str(asset['id']), 'PATCH', {'name': name})
notes = f'''Windows / macOS / Linux 版本 {version}，Android 版本 0.4.0。

本次安装包来自已全部通过的 [GitHub Actions 构建]({run['html_url']})，源码提交 `{sha}`。

- Windows：安装版 Setup.exe、便携版 Windows.exe。
- macOS：macOS-arm64.dmg，适用于 Apple Silicon；未签名和公证，Intel Mac 未包含。
- Linux：Linux-x64.AppImage。
- Android-debug.apk：保留原调试签名，可用于此前同签名版本的覆盖安装。
- Android-CI-debug.apk：本次 GitHub 构建的测试包，使用独立 CI 调试签名，不能直接覆盖原 Android-debug.apk。已有用户需要覆盖安装时请选择原包。
- Source.zip：与此次成功构建完全一致的源码。SHA256SUMS 文件包含全部安装包与源码的校验值。

功能包括：Windows MCP 消息发送与文件上传、图片粘贴与附件确认发送、Android 系统分享到剪剪，以及网页/Windows 下载进度、速度、完成/失败反馈和取消下载。

自动化测试及四个平台构建均通过。构建成功不等于各平台真机验收通过；Android 分享及 macOS/Linux 实机行为仍需对应设备验证。
'''
release = api('/releases/' + str(release['id']), 'PATCH', {'body': notes, 'target_commitish': sha, 'make_latest': 'true'})
for name, data in output.items():
    asset = next(asset for asset in release['assets'] if asset['name'] == name)
    assert asset['digest'] == digest(data) and asset['size'] == len(data)
assert all(not asset['name'].startswith('pending-' + run_id) for asset in release['assets'])
print('Published:', release['html_url'], flush=True)
with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
    summary.write(f"Release updated: {release['html_url']}\n\nBuild source: `{sha}`\n\n")
    for asset in release['assets']:
        summary.write(f"- {asset['name']} ({asset['size']} bytes)\n")
