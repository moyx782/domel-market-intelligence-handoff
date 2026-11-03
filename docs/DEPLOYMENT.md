# 可信内网部署

本部署面向**公司内网的单主机服务**：一个 Node 进程同时提供 API、SSE 和构建后的前端。没有 TLS、没有登录、没有限流；只在可信网络使用，不要映射到公网。

安全与权限模型由后续专项优化；当前部署假设网络与主机可信。

## 1. 拓扑

```
浏览器 ── http://<host>:8788 ──> Node 进程
                                 ├─ /api/v1/*      API + SSE
                                 ├─ /health        健康检查
                                 └─ /*             dist/ 静态前端（SPA 回退）
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
# MINERU_LOCAL_URL=http://127.0.0.1:8000

LOCAL_API_BIND=0.0.0.0 LOCAL_API_PORT=8788 SERVE_STATIC=1 npm run start
```

访问 `http://<host>:8788/`。`SERVE_STATIC=0` 可关闭静态服务（只跑 API）。

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

- 镜像内不包含 `.env.host` 或 `.local/`；它们通过 env_file 与 volume 提供。
- `.local/` 挂载到宿主机，容器重建不丢数据。
- 健康检查访问 `http://127.0.0.1:8788/health`。

## 4. 网络与防火墙

- 监听 `0.0.0.0:8788`；只在内网接口暴露。
- 需要放行 8788/tcp，例如 firewalld：

```bash
sudo firewall-cmd --add-port=8788/tcp --permanent
sudo firewall-cmd --reload
```

- 建议用内网 DNS（如 `domel.internal`）指到主机，避免用 IP 演示。
- 反向代理/HTTPS 不是必需；如果以后要加，保持 SSE 不缓冲（`proxy_buffering off`）。

## 5. 数据与备份

| 路径 | 内容 |
|---|---|
| `.local/domel.json` | 项目、来源、发现、审核、报告 |
| `.local/agent-config.json` | 角色、CLI、OCR、skills、plugins（0600） |
| `.local/agent/mcp.json` | MCP server 配置（0600） |
| `.local/agent/skills/`、`extensions/` | Skills 与插件目录 |
| `.local/agent/sessions/` | Agent 会话文件 |
| `.local/workspaces/` | Agent 工作区 |
| `.local/assistant/` | 只读助手会话 |

备份：停服务后打包 `.local/`，或在线 `tar czf backup.tgz .local`（写入是原子替换，在线备份一般可用）。

```bash
sudo systemctl stop domel-demo
tar czf domel-$(date +%F).tgz .local
sudo systemctl start domel-demo
```

## 5.1 角色

功能角色：`viewer < user < admin < system`。可以在设置页由 admin 切换 admin/user/viewer；`system` 只能通过本地 CLI 设置：

```bash
node scripts/agent-admin.mjs role system
node scripts/agent-admin.mjs cli --enabled on --bash off
node scripts/agent-admin.mjs show
```

Agent 工具权限（文件读写 / Shell）只有 system 可改；`viewer` 只读，`user` 可做研究与 Agent 对话但不能增删 MCP/Skills/插件。默认全开：文件读写、Shell、以及新增/手工放入的 MCP、Skill、插件都是启用状态；只有被显式关闭的项才会关闭。传输安全与存储加密不在当前实现范围。

## 6. 运行注意

- **一个进程**：SQLite/JSON 存储是单进程写入；不要对同一 `.local/` 起多个实例。
- **MCP stdio**：`agent/mcp.json` 里的 `command`/`args` 用绝对路径；子进程继承工作区目录。
- **Playwright**：运行时不依赖 Playwright；采集器启用后再装浏览器或用系统 Chrome。
- **MinerU**：默认关闭；官方 API 需 token，自建需独立服务与 GPU。见 [DOCUMENT_PARSING.md](DOCUMENT_PARSING.md)。
- **内存**：Agent 会话与 MCP 子进程常驻；建议 2 GB 以上。
- **日志**：进程 stdout/stderr；systemd 用 journalctl，Docker 用 compose logs。

## 7. 故障排查

| 现象 | 检查 |
|---|---|
| 访问 404 或空白 | 是否执行了 `npm run build`，`dist/index.html` 是否存在，`SERVE_STATIC` 是否为 1 |
| API 报“not configured” | `.env.host` 是否有 `DEEPSEEK_API_KEY`，进程是否重启 |
| 端口占用 | `ss -ltnp | grep 8788` |
| SSE 不更新 | 反向代理是否缓冲；同源直连是否正常 |
| MCP 工具不出现 | `agent/mcp.json` 名称/格式；`auth.log`/`agent/mcp.log`；绝对路径；`POST /api/v1/agent/mcp/test` |
| 权限问题 | 当前版本只有本地角色，未见效的鉴权；按“可信网络”使用 |

## 8. 健康检查

```bash
curl -s http://127.0.0.1:8788/health
# {"status":"ok","architecture":"local-single-user"}
```

`/health` 只表示进程存活，不检查 DeepSeek、MCP 或数据库外部依赖。
