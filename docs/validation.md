# 验证记录

## Android v0.2.1 启动修复（2026-10-05）

- 用户反馈：Android 16，0.2.0 APK，打开后立即闪退。尚未取得该手机的崩溃日志。
- 确认代码缺陷：0.2.0 的 `configureWindow()` 在 `setContentView()` 之前调用 `PhoneWindow.getInsetsController()`；[Android 16 官方源码](https://android.googlesource.com/platform/frameworks/base/+/android-16.0.0_r1/core/java/com/android/internal/policy/PhoneWindow.java#4139) 直接访问 `mDecor`，尚未创建 Decor 时会空指针。修复将控制器读取及浅色系统栏设置移到 `setContentView()` 之后；不删除原有 Insets 和键盘适配。此缺陷与症状吻合，但未把用户真机原因视为已经日志确认。
- `assembleDebug assembleDebugAndroidTest lintDebug` 成功，Lint 0 错误、3 个原有警告。APK 版本为 0.2.1 / versionCode 3，minSdk 29、targetSdk 35。
- APK v2 签名验证通过，证书 SHA-256 为 `32ee3ebe1521bf2d82781cf8add902c99cf1574ed5fd59fcca884752ea26186c`，与旧包相同。4 个内置网页资源逐一与当前源码比对一致，APK ZIP 完整性通过；校验文件为 `releases/SHA256SUMS-Android-0.2.1.txt`。
- 新增 `LaunchSmokeInstrumentation`，在设备上启动真实 Activity，检查系统栏控制器和真实登录页/原生桥接，不使用模拟页面。测试 APK 已编译；运行命令为 `adb shell am instrument -w app.jianjian.mobile.test/app.jianjian.mobile.LaunchSmokeInstrumentation`，需先安装主 APK 与 `android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`。
- 运行验证限制：当前无 ADB 真机。独立 Android 16 软件模拟器两次启动失败，宿主退出码 `0xC0000005`，因此设备启动测试尚未执行。日志保存在 `test-results/android36-avd/`；未更改系统虚拟化或其他 AVD。仍需手机覆盖安装确认启动、系统栏与键盘行为。

## v0.3.0 Windows 悬浮窗（2026-10-04）

- 范围：本轮交付 Windows 安装版、便携版及源码；Android、Linux 与公网服务保持 0.2.0。
- `npm test`：54 项全部通过，包括 10 项悬浮窗渲染测试、9 项主进程/窗口测试和 9 项同步生命周期测试；原服务端、主界面、剪贴板测试也通过。
- 构建：Windows x64 安装版与便携版均成功；打包后的 app.asar 版本为 0.3.0，全部 14 个桌面/网页及版本文件与源码逐一核对。源码归档及三项交付文件的校验值见 `releases/SHA256SUMS-0.3.0.txt`。
- 新增回归覆盖悬浮窗入口、最近 50 条列表与实时事件合并、阅读位置、文件回主界面、中文输入法、发送失败重试去重、窗口隐藏与恢复、位置持久化、IPC 权限隔离、退出/切换账号的迟到响应，以及离线冷启动和重连。
- Windows 原生运行：使用独立本机测试服务（8791）及测试账号启动真实 Electron 主窗口和悬浮窗。通过 Windows 控件树观察到历史文字、文件卡片、实时新增消息、输入文字后发送按钮启用，以及停服/恢复后的离线和在线状态。主进程诊断确认消息事件广播给两个窗口，悬浮窗列表通过实际服务端 API 读取。
- 验证边界：Windows 截图组件连续返回 `FrameArrived timed out` / `window capture timed out`，鼠标操作返回 `coordinate input geometry is unavailable`，部分控件树快照也不稳定。未将实际鼠标拖动、边缘缩放、点击发送/复制/文件跳转和最小尺寸像素效果列为人工验收通过；对应逻辑由自动测试覆盖，仍需安装后的正常桌面试用确认。
- 小窗和主窗共用实时连接与账号，小窗桥接不暴露登录令牌，不允许修改账号或设置。退出/换账号会取消未完成请求、销毁小窗并丢弃旧响应；已有文件下载结果也不会提示给新账号。

## v0.2.0 界面改版（2026-10-04）

- `npm test`：21 项通过。新增 7 项直接执行实际 app.js 的回归，覆盖超过 50 条历史、加载期间实时增删、重连校正离线删除、筛选竞态、底部设置、返回取消确认、旋转时键盘状态及短视口输入高度。
- 浏览器实际操作：本机登录、中文多行发送、文件上传、文件筛选与文件名搜索、取消删除、设备设置及保存提示。实时消息到达与加载更早记录后，原可见消息偏移变化不超过 0.25px；回到最新后底部距离为 0。
- 尺寸检查：390×844、320×568、1366×900 无页面横向溢出；390×430 模拟键盘缩小视口，844×230 检查横屏、多行输入与工具栏同时存在，发送按钮保持可见。此项是浏览器视口验证，不等同于真实 Android 键盘。
- Android：`assembleDebug lintDebug` 成功，0 错误、3 警告（target SDK、低版本忽略新版返回属性、本地 WebView JavaScript）。APK 0.2.0 / versionCode 2，签名 SHA-256 与 v0.1.0 一致，APK 校验通过。
- Windows：0.2.0 安装版和便携版构建成功；打包后的 app.asar 版本号、4 个 UI 文件与当前源码一致。Android APK 中的 4 个 UI 文件也逐一比对一致。
- Linux：0.2.0 x64 AppImage 在 Ubuntu 24.04 构建成功，下载前后 SHA-256 一致，构建目录中的 4 个 UI 文件与当前源码一致。未进行 Linux 图形桌面运行验证。
- 公网：`部署地址已移除` 已更新，4 个 UI 资源逐个通过 HTTPS 哈希比对。源文件回退备份位于服务器 `/var/backups/jianjian-ui-20261004T054855Z`。
- 截图：`test-results/chat-mobile-v020.png`、`chat-desktop-v020.png`、`chat-small-phone.png`、`chat-landscape-keyboard.png`。内容来自本地测试账号。
- 限制：当前无 adb 真机连接，环境无可用硬件加速模拟器；Android 状态栏、三键/手势导航、真实软键盘和横竖屏切换仍需手机覆盖安装后确认。内置浏览器的下载事件等待超时，界面未报错；未将本次浏览器保存文件视为验收通过。文件传输 API 的自动测试通过。

## v0.1.0 验证记录

验证日期：2026-10-04。自动化测试使用独立测试数据。公网联调使用剪剪管理员账号与两台专用验证设备，测试消息和文件在验证后清理，验证会话已退出。

## 已通过

- `npm test`：Windows 本机与 Ubuntu 服务器均 14 项通过。认证、账号隔离、管理员权限、幂等消息、来源设备不可伪造、离线补同步、分页、筛选、搜索、文件限额、下载、到期清理、删除、SSE 事件、停用账号和登录令牌撤销。
- 服务器：`jianjian.service` 处于 active 状态，`127.0.0.1:8787/api/health` 返回正常。使用独立 Node.js 24.21.0，不影响系统 Node.js 22。
- 公网入口：`部署地址已移除`，默认系统信任链验证通过，未绕过 TLS 校验。现有 Caddy 平滑重载，进程未重启，其他站点配置哈希保持一致；443 上临时添加的剪剪路由已撤下。
- 公网联调：网页资源、登录、两个独立设备会话的文字/剪贴板 SSE 事件与设备标注、历史读取、SSE 重连、未登录访问拒绝、超过 2 MB 文件上传下载及 SHA-256 一致性通过。此项验证服务端及代理，不代替客户端的系统剪贴板实机验收。
- 剪贴板行为：自动发送关闭时不传输；自动写入独立生效；手动复制与远端自动复制不回传；历史补同步不覆盖剪贴板；离线重试使用同一消息 ID；较新的远端内容清除较旧的待发剪贴板。
- Windows：Electron 安装版、便携版构建成功。客户端启动到登录界面，原生桥接能读取本机设备名称。尚未以真实远端服务器完成全链路桌面剪贴板验收。
- Linux：已在 Ubuntu 24.04 服务器构建 x64 AppImage。服务器没有图形桌面，因此未进行 Linux 窗口、托盘、X11/Wayland 剪贴板实机验收。
- Android：测试 APK 构建成功，APK v2 签名验证通过。Android Lint 无错误；保留目标 SDK 35 和启用本地 JavaScript 的提示，实际代码将原生桥接限制在打包的本地页面。
- 浏览器：本机真实登录、发送中文及多行消息、上传中文文件名、文件类型筛选、文件名搜索、设置与管理员界面；未见控制台错误。390×844 手机尺寸检查无横向溢出。
- 可查看 `test-results/timeline-desktop.png`、`test-results/timeline-mobile.png`，均来自实际运行的本地测试界面。

## 待完成

- Android 真机：后台接收、锁屏、厂商省电策略、系统文件下载、剪贴板读取/写入权限实际行为。
- macOS：已提供源代码、打包配置和 CI，但尚未在 macOS 编译与运行。Linux 尚待桌面运行验证；Wayland 自动读取会被明确禁用，保留手动发送。
- 500 MB 文件的持续上传、弱网和多人并发压力测试。当前自动测试只使用小文件验证限制逻辑与存储行为。
- Windows 发行证书及 macOS 签名、公证。Android 当前为调试签名 APK。

当前交付是可继续联调的第一版，不应将以上待验收项视为全部平台已经验证通过。


## 0.4.1 下载反馈验证

- Node 测试覆盖 Windows 下载流式写盘、阶段状态、累计字节、慢速分块传输的中间进度与速度、取消清理临时文件、保留已有目标文件、截断文件检测和账号切换隔离。
- 共享界面测试覆盖浏览器等待响应状态、流式保存、失败反馈及阻止重复下载。
- 隔离 Electron 页面使用延迟响应及 2 MB 分块数据验证连接中、百分比与速度、保存完成和取消状态；证据在 `test-results/download-ui-smoke.json` 和 `test-results/download-progress.png`。这项界面验证使用模拟响应和可写文件接口；磁盘写入及清理另由真实文件系统测试验证。
- 无文件系统保存接口的浏览器仍使用 Blob 暂存，界面将最终状态明确标为已交给浏览器保存，不将其当作磁盘保存完成。
- 2026-10-20 12:25（Asia/Shanghai）已将三个网页静态资源部署至公网，带查询参数和不带查询参数的 HTTPS 内容均与本地 SHA-256 一致，健康检查正常；未重启服务。服务器备份：`/var/backups/jianjian-download-ui-20261020T042557Z`。部署记录：`test-results/download-ui-deployment.json`。
