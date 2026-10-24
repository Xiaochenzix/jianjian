# 剪剪

自己的设备之间同步消息、文件和剪贴板。支持 Windows、Android 和网页，服务端可自行部署。

下载客户端请前往 [GitHub Releases](https://github.com/Xiaochenzix/jianjian/releases/latest)：Windows 当前版本 **0.4.1**，Android 当前版本 **0.4.0**（调试签名测试包）。

## 0.4.1 下载反馈

网页和 Windows 增加常驻下载任务区，显示等待连接、百分比、已下载大小、速度、保存中及完成/失败结果，支持取消和防止重复下载。Windows 流式写入临时文件，成功后再保存到目标位置；退出账号会取消下载，取消或失败时会清理临时文件，主界面重载后可恢复查看任务。支持 `showSaveFilePicker` 的安全上下文浏览器在选择位置后直接流式写入磁盘；其他浏览器分块接收并显示进度，接收完交给浏览器保存，仍需足够内存暂存文件。任务区的“已交给浏览器保存”不代表浏览器已完成磁盘保存。网页静态资源更新后需刷新；Windows 更新包为 0.4.1，Android 仍为 0.4.0。

## 0.4.0 新增功能

- Windows 托盘菜单勾选“启用 MCP（AI 可读消息及发送文件）”，然后选择“复制 MCP 连接配置”。将 JSON 中的 `jianjian` 配置添加到支持 Streamable HTTP 和自定义 Authorization 请求头的 AI 客户端。先在剪剪登录，AI 会使用当前账号操作；切换账号时正在进行的调用会取消。提供 `send_message`、`upload_file`（本机文件绝对路径）、`list_messages`、`list_devices`。MCP 默认关闭，只监听本机，需要配置中的访问令牌；启用即允许持有配置的本机 AI 客户端读取消息、上传可访问的本机文件及发送文字。关闭再启用或重启应用后，需重新复制连接配置。不要分享此配置。
- 消息输入栏支持 Ctrl+V 粘贴图片；图片和选取的文件先进入附件列表，可移除，点击发送后上传。失败的附件保留，可重试。文字与文件分别生成消息。
- Android 系统分享菜单支持“剪剪”，接收文字、链接、图片及多个文件。分享内容进入输入栏和附件列表，登录后确认发送。分享文件在本次应用运行中读取，请在关闭应用前完成发送。普通文件选择和下载功能继续可用。

Windows 和 Android 本次版本均为 `0.4.0`。安装文件位于 `releases/`。

部署在自己服务器上的消息、文件和文字剪贴板同步工具。一个账号连接自己的 Android、Windows、macOS 和 Linux 设备；不同账号互相隔离。Windows 当前测试版本为 `0.4.1`，Android 为 `0.4.0`，Linux 和已部署服务端沿用 `0.2.0`。

## 已实现

- 微信式消息布局：文字、剪贴板和文件按时间从上到下排列，最新在底部；本机绿色气泡、其他设备白色气泡，标注来源设备。支持筛选、搜索、向上加载历史、复制和删除。
- Windows 悬浮窗：主界面右上角或托盘菜单打开，置顶、可拖动和调整大小，记住位置；显示最近 50 条消息，支持实时接收、复制文字、Enter 发送与 Shift+Enter 换行。文件卡片返回主界面查看。关闭小窗保留后台同步，退出账号清空小窗，断线自动重连。
- 安卓窗口统一处理状态栏、导航栏、刘海和键盘边距，网页不重复留白；聊天区独立滚动，输入栏随可视区域缩放，设置采用手机全屏页面。
- 账号登录、管理员创建/停用账号、设备自动识别和重命名；无公开注册、无跨用户聊天。
- 实时事件通知及断线重连；重连后重新读取服务端时间线，恢复离线期间产生的记录。
- 文件流式上传、按需下载、默认 500 MB 上限、7 天保留；过期清理保留“已过期”消息。管理员可配置文件大小、保留天数及用户总额度（默认 5 GB）。
- 各设备独立的“自动发送剪贴板”和“自动写入本机剪贴板”，默认关闭。只处理文字和链接。
- 桌面托盘常驻、开机启动；Android 可选择通过前台服务保持后台连接。
- 桌面通过系统密钥环加密保存登录信息，Android 使用 Android Keystore。系统密钥环不可用时桌面只在内存保存登录信息。

## 快速运行服务端

需要 **Node.js 24 或更新版本**。服务端使用 Node 内置 HTTP、SQLite 和加密库，不需要安装 npm 依赖。

```powershell
# Windows PowerShell：只在首次初始化时执行。自行设置一个新的强密码。
$env:JIANJIAN_ADMIN_PASSWORD = '替换成你自己的至少12位密码'
npm run admin -- admin
Remove-Item Env:JIANJIAN_ADMIN_PASSWORD
npm start
```

```bash
# Linux/macOS：交互输入初始管理员密码，不把密码写到 shell 历史中。
read -rsp 'Admin password: ' JIANJIAN_ADMIN_PASSWORD; echo
export JIANJIAN_ADMIN_PASSWORD
npm run admin -- admin
unset JIANJIAN_ADMIN_PASSWORD
npm start
```

默认监听 `http://127.0.0.1:8787`，数据写到 `./data`。环境变量：`HOST`、`PORT`、`DATA_DIR`。网页可用于消息和文件操作；自动剪贴板必须使用客户端。

只想看本地测试界面时，执行 `node scripts/preview.mjs`。它只监听本机，使用独立的 `test-results/preview-data` 数据库和测试账号 `preview / Preview-Only-2026!`。**此测试账号不能用于公网部署。**

## 电脑客户端

```bash
npm ci
node node_modules/electron/install.js
npm run desktop
npm run build:windows  # Windows 安装版及便携版
npm run build:mac      # 在 macOS 构建 DMG
npm run build:linux    # 在 Linux 构建 AppImage
```

输出在 `releases/`。Windows 安装版、便携版及 Linux x64 AppImage 已构建。未配置商业代码签名证书。正式公开分发前需要完成 Windows 签名和 macOS 签名、公证。macOS 的构建脚本已提供，安装包需要在 macOS 环境生成；Linux 图形桌面实际运行尚待验证。不能把构建成功视为全部平台的实际功能验收通过。

关闭窗口会隐藏到托盘，托盘菜单可完全退出。开机启动需要打包后的客户端；Linux 启动入口写入用户自己的 `~/.config/autostart/jianjian.desktop`。Linux Wayland 的后台剪贴板读取取决于桌面环境授权，需实际验证。

Windows 悬浮窗与主界面共用账号、设备身份和一条实时连接，沿用本机剪贴板开关。上次退出应用时仍开启的小窗会在下次已登录启动时恢复；关闭小窗后不会自行弹出。位置和大小单独保存在本机配置中，显示器变化时会调整到可用屏幕内。新版交付为 `releases/Jianjian-0.4.1-Setup.exe`（安装版）和 `releases/Jianjian-0.4.1-Windows.exe`（便携版）。

## Android 客户端

原生 Java 外壳、系统剪贴板接口、系统文件选择/下载、共享本地界面。需要 Android 10（API 29）或更新版本、支持现代 JavaScript 的系统 WebView。

构建需要 JDK 17+、Gradle 8.9、Android SDK 35：

```bash
gradle -p android assembleDebug
```

APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`，交付副本为 `releases/Jianjian-0.4.0-Android-debug.apk`，属于调试签名测试包。版本号 0.4.0、versionCode 4，与 0.1.0 / 0.2.0 使用相同签名，支持直接覆盖安装。0.2.1 将系统栏控制器的读取移到内容窗口创建后，修复启动时可能出现的空指针；此前的系统栏与键盘边距处理保留。正式发布时应配置自己的签名密钥并备份，不能使用调试密钥作为正式长期发行密钥。

Android 10+ 普通应用在后台不能读取剪贴板。剪剪会显示这个限制；开启自动发送后，在应用有焦点时监听复制变化，并在回到应用时读取当前文字。后台连接开关用于接收新消息，不会解除系统的剪贴板读取限制。接收后自动写入剪贴板也受系统策略影响，失败会显示提示。未使用辅助功能、Root 或 ADB 绕过系统限制。

后台接收使用 `remoteMessaging` 前台服务，开启后有常驻通知；厂商省电、强制停止、重启设备仍可能中断服务，需要重新打开应用。当前版本不承诺锁屏时自动读取其他应用的剪贴板。手机端只连接证书可信的 HTTPS 服务器。

## 服务器部署

部署完成后，在网页或客户端填写你自己的 HTTPS 服务地址，例如 `https://sync.example.com`。自建部署时请自行创建管理员账号。

详见 [部署说明](deploy/README.md)。剪剪服务绑定 `127.0.0.1:8787`，现有 Caddy 通过独立 HTTPS 8443 端口代理，使用系统信任的 IP 证书。证书沿用现有自动续期配置。

Docker 和 systemd 模板均已提供。客户端首次登录时输入实际 HTTPS 地址。数据库包含用户消息和文件索引；文件位于 `data/files`。传输依赖 HTTPS，**当前不是端到端加密**，服务器管理员可访问服务器上的数据。

## 测试

```bash
npm test
```

测试使用随机临时目录和独立测试账号，覆盖认证、跨用户隔离、文件收发与过期清理、消息去重、历史分页与搜索、SSE 事件、账号停用/退出登录，以及桌面剪贴板开关、回传循环和离线重试。

真实手机的厂商省电策略、macOS 权限、Linux X11/Wayland、500 MB 文件的弱网长时间上传，还需要对应设备上的验收。浏览器响应式检查不能代替这些平台验收。

## 项目品牌 MV

已制作《让灵感流动》：48 秒、1920×1080、30 fps，六段 Canvas 动画配合 120 BPM 原创程序合成电子配乐。成片位于 `releases/jianjian-mv.mp4`（H.264 + AAC）。动画和音乐都由代码生成，无外部音视频素材；不含人声演唱。

```bash
npm run mv          # 本机播放器 http://127.0.0.1:8790，支持暂停、进度、章节、静音和全屏
npm run mv:render   # 重新导出 1080p MP4
npm run mv:audio    # 单独生成 releases/jianjian-mv.wav
npm run mv:render -- --frames 3,11,19,27,35,43  # 六段分镜 PNG，输出到 test-results/mv/
```

预览只需 Node.js；导出使用项目已有的 Electron 和支持 H.264/AAC 的 FFmpeg。先执行 `npm ci` 并确认 Electron 已安装；FFmpeg 可通过 `FFMPEG_PATH` 指定，也会检测系统 PATH、`.tools/` 和 Python 的 `imageio_ffmpeg`。本机已安装独立编码器；新环境可显式执行：

```bash
python -m pip install --target .tools/mv-python imageio-ffmpeg==0.6.0
```

动画文案、颜色与分镜在 `mv/film.js`；配器、旋律与节奏在 `scripts/mv-audio.mjs`。网页和视频使用同一套时间驱动画面，音乐作为网页播放时钟。预览服务仅开放短片所需文件，独立于应用服务和业务数据。`MV_PORT` 可修改预览端口。中文字体使用系统微软雅黑或苹方；其他系统应安装中文字体以避免缺字。命令行支持 `--width`、`--height`、`--fps` 和 `--output`，建议保持 16:9 比例。

## 目录

| 路径 | 内容 |
| --- | --- |
| `server/` | HTTP API、SQLite、流式文件传输和实时事件 |
| `web/` | 各端共用的时间线、设置、管理员界面 |
| `desktop/` | Electron、托盘、系统剪贴板、密钥环 |
| `android/` | Android 客户端与后台连接服务 |
| `deploy/` | Docker、systemd、Nginx、Caddy 配置模板 |
| `tests/` | 服务端与剪贴板同步行为测试 |
| `.github/workflows/` | 分平台构建配置，需在自己的仓库启用 |

需求基线见 [已确认需求](docs/requirements.md)。
