# 可信内网部署

本部署面向**公司内网的单主机服务**：一个 Node 进程同时提供 API、SSE、任务队列和构建后的前端。没有 TLS、没有登录、没有限流；只在可信网络使用，不要映射到公网。

安全与权限模型由后续专项优化；当前部署假设网络与主机可信。功能角色（viewer/user/admin/system）只做功能层权限，不替代网络认证。

## 1. 拓扑

```
浏览器 ── http://<host>:8788 ──> Node 进程（单实例）
                                 ├─ /api/v1/*      API + SSE（助手/Agent/任务）
                                 ├─ /health        健康检查
                                 └─ /*             dist/ 静态前端（SPA 回退）
                                    │
                                    └─ 后台：任务队列（单 worker）+ 来源调度器
                                       + Node 采集器（HTTP/Chrome）+ Agent 运行时
```

同源访问，不需要 CORS，也不需要单独的前端服务器。

## 2. 直接运行（systemd 或裸进程）

```bash
cd domel-market-intelligence
npm ci
npm run build

# .env.host（不进 git）
# DEEPSEEK_API_KEY=sk-...
# DEEPSEEK_MODEL=deepseek-flash
# MINERU_PROVIDER=none

LOCAL_API_BIND=0.0.0.0 LOCAL_API_PORT=8788 SERVE_STATIC=1 npm run start
```

首次启动会在 `.local/` 下创建：

| 文件 | 内容 |
|---|---|
| `domel.json` | 研究项目、来源摘录、发现、审核、报告 |
| `tasks.json` | 持久任务队列（重启恢复） |
| `source-registry.json` | 来源注册表，首次从 `seed/sources-cn.json` 导入 30 个中国来源 |
| `events.json` | 展会资料库 |
| `documents.json` | 采集到的页面（URL 去重） |
| 地理表 | `seed/geo-cn.json`（随代码分发；`GEO_FILE` 可覆盖） |
| `recipes.json` | 采集 recipe（proposed/approved/disabled） |
| `agent-config.json` | 角色、CLI 开关、OCR 配置、skills/plugins 元数据（0600） |
| `agent/mcp.json` | MCP server 配置（0600） |
| `agent/transcripts.json` | Agent 运行历史（Agent 页只读历史） |
| `events.json` | 展会资料库（含国家/省/市/区县与来源） |
| `agent/`、`workspaces/`、`assistant/` | Pi 会话、工作区、只读助手会话 |

访问 `http://<host>:8788/`。`SERVE_STATIC=0` 可关闭静态服务（只跑 API）。

**地理/官网数据**：展会国家/省/市/区县来自 `seed/geo-cn.json` 存储表（升级仓库后如需要可停服务运行 `npm run event:backfill-geo` 补齐旧事件）。展会补全会在没有官网时通过 DeepSeek Web Search 找候选并抓取核验。

**AI 密钥**：可写 `.env.host` 的 `DEEPSEEK_API_KEY`，也可由 admin 在 **设置 → AI 模型**
里填写（只写不读、`.local/agent-config.json` 0600、优先于环境变量、保存后即时生效）。
本地部署的模型（Ollama/vLLM/LM Studio 等）在 Base URL 填 OpenAI 兼容地址即可；
此时没有 DeepSeek search/fetch 工具，展会发现退回来源注册表扫描。

**采集器需要浏览器**：HTTP 抓取不需要任何东西；JS 壳页面回退 Playwright 时使用系统 Chrome（`CHROME_PATH` 或 `/usr/bin/google-chrome`）。服务器上没有 Chrome 时采集器仍能工作（只做 HTTP/Readability），只是缺少 JS 渲染回退。

systemd：

```bash
sudo useradd --system --home /opt/domel --shell /usr/sbin/nologin domel
sudo mkdir -p /opt/domel && sudo chown domel:domel /opt/domel
# 将仓库内容放到 /opt/domel，配置 /opt/domel/.env.host
sudo cp deploy/domel-demo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now domel-demo
systemctl status domel-demo
journalctl -u domel-demo -f
```

`deploy/domel-demo.service` 的 `ExecStart=/usr/bin/node` 需要按本机改；nvm 安装的 Node 不在 `/usr/bin`，改成 `which node` 的绝对路径。

更新：

```bash
cd /opt/domel
sudo -u domel git pull
sudo -u domel npm ci
sudo -u domel npm run build
sudo systemctl restart domel-demo
```

## 3. Docker / Compose

```bash
# .env.host 放在 docker-compose.yml 同级
docker compose build
docker compose up -d
docker compose logs -f
```

- 镜像内不包含 `.env.host` 或 `.local/`；它们通过 env_file 与 volume 提供（见 `.dockerignore`）。
- `.local/` 挂载到宿主机，容器重建不丢数据（任务队列/展会资料/来源注册表都在这里）。
- 健康检查访问 `http://127.0.0.1:8788/health`。
- 镜像内没有 Chrome（`node:22-alpine`），采集器只走 HTTP/Readability；需要 Playwright 回退时用直接部署或自行在镜像中安装 Chromium 并设置 `CHROME_PATH`。

## 4. 网络与防火墙

- 监听 `0.0.0.0:8788`；只在内网接口暴露。
- 需要放行 8788/tcp，例如 firewalld：

```bash
sudo firewall-cmd --add-port=8788/tcp --permanent
sudo firewall-cmd --reload
```

- 建议用内网 DNS（如 `domel.internal`）指到主机，避免用 IP 演示。
- 反向代理/HTTPS 不是必需；如果以后要加，保持 SSE 不缓冲（`proxy_buffering off`）。

## 5. 备份与重置

备份：停服务后打包 `.local/`，或在线 `tar czf backup.tgz .local`（写入是原子替换，在线备份一般可用）。

```bash
sudo systemctl stop domel-demo
tar czf domel-$(date +%F).tgz .local
sudo systemctl start domel-demo
```

重置：

```bash
sudo systemctl stop domel-demo
sudo -u domel rm -rf .local
sudo systemctl start domel-demo
```

- 删除 `source-registry.json` 会在下次启动时重新导入种子来源；`scripts/agent-admin.mjs` 只操作 `.local/agent-config.json`。
- **不要对同一个 `.local/` 起两个进程**：JSON 存储是单进程写，任务队列/调度器会互相覆盖。

## 6. 角色

功能角色：`viewer < user < admin < system`。设置页可以由 admin 切换 admin/user/viewer；`system` 只能通过本地 CLI 设置：

```bash
node scripts/agent-admin.mjs role system
node scripts/agent-admin.mjs cli --enabled on --bash off
node scripts/agent-admin.mjs show
```

- `viewer`：只读所有页面（含 Agent 历史），不能创建任务、不能审核、不能聊天。
- `user`：可创建任务、审核、生成报告、Agent 对话、开关 MCP/Skills/插件/来源。
- `admin`：增删改设置、来源、recipes、插件；不能授予 system。
- `system`（T0）：文件/Shell 开关、CLI；只能本地设置。Web 降级后需 `npm run agent:admin -- role admin` 恢复。
- 默认全开：文件读写、Shell、以及新增/手工放入的 MCP、Skill、插件都是启用状态；只有被显式关闭的项才会关闭。

传输安全、登录、存储加密不在当前实现范围。

## 7. 运行注意

- **单进程**：见上，一个 `.local/` 只跑一个实例。
- **任务队列**：API 与队列同进程；`SIGINT/SIGTERM` 会先停止队列（abort 运行中的 handler）再退出，重启自动恢复 queued/running 任务。
- **来源调度**：启动后立即 tick 一次，把到期来源排入队列；默认每 30s 一次。单域请求间隔默认 5s，遇 403/WAF 会暂停该来源，需要人工在来源页处理。
- **地理表**：`GEO_FILE`（默认 `seed/geo-cn.json`）；新增展会城市/展馆时补表，代码无需改。
- **升级**：`git pull && npm ci && npm run build`；旧 `.local/events.json` 在读取时会自动补
  `province`/`district` 空字段，离线回填用 `npm run event:backfill-geo`（先停服务）。
- **MCP stdio**：`agent/mcp.json` 里的 `command`/`args` 用绝对路径；子进程继承工作区目录。
- **MinerU**：默认关闭；官方 API 需 token，自建需独立服务与 GPU。见 [DOCUMENT_PARSING.md](DOCUMENT_PARSING.md)。
- **内存**：Agent 会话、MCP 子进程、Playwright Chrome 可能常驻；建议 2 GB 以上。
- **日志**：进程 stdout/stderr；systemd 用 journalctl，Docker 用 compose logs。

## 8. 故障排查

| 现象 | 检查 |
|---|---|
| 访问 404 或空白 | 是否执行了 `npm run build`，`dist/index.html` 是否存在，`SERVE_STATIC` 是否为 1 |
| API 报“not configured” | `.env.host` 是否有 `DEEPSEEK_API_KEY`，进程是否重启 |
| 任务一直 queued | 队列是否在跑（日志有 `Tasks:` 行）；是否有运行中的长任务；`.local/tasks.json` 是否可写 |
| 来源一直 error/paused | 来源页看 `lastError`；403/WAF 会暂停；确认网络与 robots.txt |
| 展会页为空 | 先点"发现新展会"或直接 `POST /api/v1/events/discover`；查看任务页结果 |
| 端口占用 | `ss -ltnp | grep 8788` |
| SSE 不更新 | 反向代理是否缓冲；同源直连是否正常 |
| MCP 工具不出现 | `agent/mcp.json` 名称/格式；`auth.log`/`agent/mcp.log`；绝对路径；`POST /api/v1/agent/mcp/test` |
| Agent 页无历史 | 检查 `.local/agent/transcripts.json`；viewer 只能看历史 |
| 权限问题 | 设置页查看当前角色；system 只能用 CLI；403 响应含 `requiredRole` |

## 9. 健康检查

```bash
curl -s http://127.0.0.1:8788/health
# {"status":"ok","architecture":"local-single-user"}
curl -s http://127.0.0.1:8788/api/v1/capabilities | python3 -m json.tool
```

`/health` 只表示进程存活，不检查 DeepSeek、MCP 或外部依赖；`/api/v1/capabilities` 会返回队列路径、采集器/Playwright 能力、来源与展会数量。
