# 自建服务器部署

服务器已经有其他服务时，先确认当前反向代理类型和端口配置。这里的模板只针对剪剪。可通过 Caddy 的独立 HTTPS 8443 端口提供访问。以下配置均需替换为你自己的服务器地址。

## 方式一：Docker

在项目根目录执行：

```bash
docker compose -f deploy/compose.yaml up -d --build
read -rsp 'Admin password: ' JIANJIAN_ADMIN_PASSWORD; echo
export JIANJIAN_ADMIN_PASSWORD
docker compose -f deploy/compose.yaml exec -e JIANJIAN_ADMIN_PASSWORD jianjian node server/admin.mjs admin
unset JIANJIAN_ADMIN_PASSWORD
curl http://127.0.0.1:8787/api/health
```

命名卷 `jianjian-data` 保存数据库和文件，不应使用 `docker compose down -v` 清理正式数据。容器只向宿主机环回地址开放 8787。首次创建管理员后，在客户端管理界面创建普通用户。

## 方式二：systemd

需要已安装 Node.js 24+（用 `node -v` 确认）。示例服务文件假设 Node 位于 `/usr/bin/node`；若安装路径不同，调整 `ExecStart`。

1. 创建专用系统账号 `jianjian`。
2. 将 `server/`、`web/` 和 `package.json` 放入 `/opt/jianjian/`。
3. 创建 `/var/lib/jianjian` 并让 `jianjian` 用户拥有写权限。
4. 将 `deploy/jianjian.service` 放到 `/etc/systemd/system/jianjian.service`。
5. 使用同一个 `DATA_DIR=/var/lib/jianjian` 和服务用户执行 `server/admin.mjs` 创建初始管理员。通过环境变量传入密码，不在命令行参数中写入密码。
6. 执行 `systemctl daemon-reload`、`systemctl enable --now jianjian`，确认健康检查正常。

## HTTPS

可以使用域名，或像当前部署一样使用系统信任的 IP 地址证书。域名部署可选择 `nginx.conf.example` 或 `Caddyfile.example`，把域名替换为实际值后合并到原配置，先校验，再重载。

IP 部署示例使用 `jianjian-ip-site.caddy`（`203.0.113.10` 为文档示例地址，必须替换），通过服务器的 ACLI 共享 Caddy 管理器注册 `jianjian` 站点片段：`/etc/caddy/acli.d/sites/jianjian.caddy`。该目录是管理器生成的符号链接；后续配置变更应调用管理器的 `acli_caddy_site_put`，不要直接改写主 Caddyfile。当前管理器库路径为 `/usr/local/lib/acli/specs/2026.09.30-4/lighthouse/0.21.x/lib/acli_caddy_manager.sh`，升级后需核实实际路径。

公网入口为 TCP 8443，后端仍为 `127.0.0.1:8787`。IP 证书使用现有 ACME shortlived 配置自动续期，HTTP 80 保留用于证书验证。客户端必须填写完整的 你自己的完整 HTTPS 服务地址（如 `https://sync.example.com:8443`）。本次通过 Caddy 2.11 的 SIGUSR1 平滑重载生效；共享配置主文件及其他站点片段哈希保持一致。变更前备份位于服务器 `/var/backups/jianjian-port-20261004T031639Z`。

SSE 事件连接必须关闭代理缓冲，并允许长连接。文件上传也应关闭代理请求缓冲，代理大小上限要与管理员设置一致。不要把文件目录配置为公开静态目录，所有下载都必须经过登录和归属检查。

API 使用 Bearer token，不使用 cookie。登录令牌最长有效期 30 天，退出登录、停用账号或同设备重新登录会使旧令牌失效。反向代理部署时，应用看到的登录来源地址会是代理地址，因此 20 次/分钟的 IP 限速目前由该代理后的用户共享；较大规模多用户部署应扩展可信代理与独立限流配置。

## 备份与恢复

最简单的一致性备份方式是短暂停止剪剪服务，再备份完整数据目录（包含 SQLite 数据库及 `files/`），随后启动服务。备份文件应存到服务器以外的受控位置。恢复也需要停止服务，恢复完整目录并检查属主权限。

保留天数调整仅影响之后的新文件。过期检查每分钟执行一次，过期下载请求会立即被拒绝；清理后消息保留过期标记。异常中断产生的临时文件与孤立文件在超过 24 小时后清理。

## 当前交付边界

2026-10-04 已在 自建服务器 部署独立服务：代码 `/opt/jianjian`，数据 `/var/lib/jianjian`，systemd 服务名 `jianjian`，专用 Node.js 24.21.0，监听 `127.0.0.1:8787`。服务健康检查与 14 项测试均通过。公网入口已接入 HTTPS 8443，系统原有 Node.js 和其他站点配置保持不变。

当前应用管理员凭据保存在本机 `releases/server-admin.local`，不在源码压缩包或版本控制中。公网已验证受信任 HTTPS、网页资源、登录、两个设备会话的文字/剪贴板实时事件、断线重连后的历史读取，以及超过 2 MB 文件的上传下载和 SHA-256 一致性。测试消息和文件已删除，验证会话已退出；设备列表中会保留两条标有“公网验证”的设备记录。Android、macOS 和 Linux 桌面实机验收边界见 `docs/validation.md`。
