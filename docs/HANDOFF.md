# 交接文档（2026-11-03）

本文件面向接手这个仓库的下一位开发者 / Agent。先读「一分钟概览」和「先跑起来」，再读计划。

## 一分钟概览

- 这是一个**单用户本地 Demo**：React 前端 + Node 本地 API + `.local/` JSON 数据，无需 Supabase、无需登录。
- 产品主流程已定为**展会资料聚合（中国优先）**：找到相关展会、提供可核验的日期/展馆/报名截止/展位价格/竞品参展等资料，由公司自行判断去不去、参不参展。
- 公司档案是**预置**的（Domel，官网 www.domel.com / components.domel.com，中国实体「多麦机电（苏州）」），用户不需要填写行业；测试与演示可直接抓 Domel 官网。
- 研究流程（项目 → 来源 → Insight → 审核 → 报告）保留为底座能力，已能真实调用 DeepSeek。
- 另有一个只读助手（SSE），以及一个已接入工作区、MCP、Skills 的 Pi Agent 运行时（后端，尚无页面）。
- 任务队列仍是进程内数组；`server/task-queue.mjs` 是未接入的草稿。
- 已确认的计划在 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)：任务闭环、来源注册表、Node 采集器 + Playwright + Agent recipe、四级角色、插件、五个前端页面。

## 先跑起来

环境：Node ≥ 22.19（本机 22.23），Chrome 156（Playwright 用系统 Chrome）。

```bash
cd domel-market-intelligence
npm ci

# .env.host（服务端密钥，已忽略提交）
# DEEPSEEK_API_KEY=sk-...
# DEEPSEEK_MODEL=deepseek-flash   # 可选
# ASSISTANT_ENABLED=0             # 可选，关闭助手

npm run demo:api        # API: http://127.0.0.1:8788
npm run dev             # 前端: http://127.0.0.1:5174
```

局域网演示（API + 前端都绑 0.0.0.0，并打印地址）：

```bash
npm run demo:lan
```

测试与构建：

```bash
npm test                # 72 个 Node 测试
npm run build           # tsc + vite
BASE=http://127.0.0.1:5174 npm run test:ui   # 42 项浏览器验收，需要 demo 在跑
```

没有 `.env.host` 时：页面可用、审核与报告可用，但研究会返回配置错误，Agent 不可用。

## 目录与关键文件

```
server/
  local-api.mjs        本地 API（研究、助手、Agent 配置/对话、任务）
  local-store.mjs      项目/来源/发现/审核/报告 JSON 存储
  assistant.mjs        只读助手 + DeepSeek 模型初始化（openDeepSeekModel）
  agent-config.mjs     MCP/Skills/角色/CLI 配置，生成 agent/mcp.json
  agent-runtime.mjs    Pi Agent 会话（工作区、MCP、Skills、CLI）
  task-queue.mjs       ⚠️ 任务队列草稿，尚未接入
  api.mjs / worker.mjs Supabase 多用户路线，暂不在本期范围

src/
  App.tsx              单文件页面路由与所有页面
  AssistantPanel.tsx   项目内只读助手
  i18n.tsx             中英词典（英文原文为 key）
  notices.ts           后端覆盖说明的渲染时翻译
  data.ts              前端数据层（local / host / demo）
  LanguageSwitch.tsx

tests/                 72 个测试（存储、API、助手、Agent/MCP、权限、静态服务、MinerU、i18n）
tests/fixtures/        可执行的 mock MCP server 与 agent probe
scripts/               demo:lan、ui-acceptance、pi spike
evidence/ui-acceptance/ 42 项浏览器验收截图与报告
docs/
  IMPLEMENTATION_PLAN.md  已确认的 v2 计划
  AGENT_RUNTIME.md        MCP/Skills 目录与 API 细节
  HOST_API.md             多用户 host API 合约（旧路线）
```

数据目录（全部被 git 忽略）：

```
.local/domel.json              项目、来源、发现、报告
.local/tasks.json              任务（接入后）
.local/agent-config.json       角色、CLI、MCP、skills、plugins
.local/agent/mcp.json          生成的 MCP 配置
.local/agent/skills/<slug>/SKILL.md
.local/agent/extensions/       插件（待实现）
.local/agent/sessions/         Pi 会话文件
.local/workspaces/<project>/   Agent 工作区
.local/assistant/              只读助手会话
```

## 已验证的能力

| 能力 | 证据 |
|---|---|
| 真实 DeepSeek 研究 | 2026-11-03：9 个候选 URL，抓 5 页，1 条 finding，状态 partial，覆盖说明完整 |
| 人工审核 + 报告 | 接受 finding 后生成 version 1 报告，快照含 1 finding / 1 source / 限制说明 |
| 只读助手 SSE | 真实模型 0.7s 返回；项目问题会调用 `list_findings` 并引用 Nidec |
| Agent + MCP | 配置 stdio mock server 后，真实模型调用 `mcp__mock__echo` 得到 `echo:hello from mcp` |
| Skills | `agent/skills/<slug>/SKILL.md` 被发现并进入会话 |
| 浏览器验收 | 49/49 通过，0 console error（桌面 + 390×844 移动端） |
| 内置公司档案 | `seed/company-domel.json`，取自 domel.com，含产品线/方案/中英关键词；`tests/company-seed.test.mjs` 校验。**注意：运行时尚未加载该 seed**，展会模块接入时使用 |
| 中英热切换 | 中文/EN 即时切换、刷新保持、通知与报告限制本地化 |

## 未完成 / 半成品

1. **任务队列未接入**：`server/task-queue.mjs` 只是草稿；研究仍由 `local-api` 的数组队列执行。
2. **角色**：四级功能权限已实现（`viewer < user < admin < system`），API 与设置页可见；`system` 只能本地 CLI 设置，CLI 开关仅 system。传输安全、存储加密不在此范围。
3. **插件**：后端有 `agent/extensions/` 目录、配置、加载与 API；设置页还没有插件管理 UI。
4. **采集器未实现**：没有 HTTP/Readability/Playwright 分级抓取，也没有 recipe。
5. **来源注册表未实现**：当前 `sources` 是抓取后的内容，不是网址。
6. **研究未由 Agent 驱动**：仍是固定管线。
7. **前端缺页面**：任务页、Agent 页未做；设置页已有角色/Agent 工具/OCR，MCP/Skills/插件管理 UI 还没接。
8. **展会资料库**：未实现。计划先做中国来源、`event.discover` / `event.enrich` 任务和展会页；企查查 MCP 只有连接能力，没有真实 server 凭据。
9. **MCP 设置 UI**：后端已把 `agent/mcp.json` 作为事实来源，支持手写、整体替换与 `POST /api/v1/agent/mcp/test` 连接测试；设置页尚未接。
10. **MinerU 文档解析**：只有配置/状态/可获取性预定义（`server/mineru.mjs`），默认关闭；规则是先给链接与可获取性，不强行 OCR。官方 API 与自部署两种 provider 见计划 8.1。

## 关键决策（已确认）

- **爬虫用 Node**，不引入 Python：Node 有 fetch/cheerio/Readability/Playwright 对等能力；Playwright 用系统 Chrome。
- **Agent 自适应抓取用 recipe**：失败页由 Agent 生成选择器/脚本，管理员审批，后续确定性复用。
- **四级角色**：`viewer < user < admin < system`；system 是 T0，只能本地 CLI/TUI 设置，Web 不可授予。
- **单 worker、单 JSON**：本机 Demo 够用；接口留好，后续换 Postgres/分布式队列。
- **插件 = Pi extension**：目录 `agent/extensions/<slug>/`，admin 安装/卸载，user 开关，viewer 只读。
- **viewer 的 Agent 页只读历史**。
- **Agent 能力默认全开**：角色 admin、文件读写、Shell、以及新增/手工放入的 MCP/Skill/插件默认启用；T0 可显式关闭。

## 已知坑

1. **MCP 子进程继承工作区 cwd**：`command`/`args` 用相对路径会静默启动失败，必须绝对路径；失败目前只写到 `agent/mcp.log`，聊天流里看不到。
2. **MCP 工具排除规则**：会话 `tools` 允许列表必须包含 `mcp__*`，否则工具不会声明给模型；`noTools: "builtin"` 会保留扩展工具。
3. **`bindExtensions` 必须调用**：MCP 在 `session_start` 才连接；SDK 默认不会自动绑定。
4. **非安全上下文没有 `crypto.randomUUID`**：LAN HTTP 下已加 UUID v4 降级；新代码不要直接调用。
5. **i18n 以英文原文为 key**：新增界面文案必须同时补 `src/i18n.tsx` 的中文，否则中文模式会漏英文；后端通知走 `src/notices.ts`。
6. **任务/来源等新 API 要注意角色**：viewer 必须只读，user 只能开关，admin 才能增删改，CLI 只有 system。
7. **测试里的 agent 会话会拉起 MCP 子进程**：测试用子进程 + `process.exit` 隔离（见 `tests/agent-mcp.test.mjs`），不要在同一个测试进程里长期挂 MCP。
8. **Demo 数据会污染验收**：跑 UI 验收或实验后，停止 API、删 `.local/` 可重置；`.local/` 不进 git。

## 数据与证据

- UI 验收截图与清单：`evidence/ui-acceptance/`（含中文页面、覆盖说明、移动端）。
- 更早的 host 路线证据：`evidence/runs/2026-10-26.../`，与本期本地 Demo 无关。
- 本机 `.local/domel.json` 里现有真实演示项目 `Live check · EC motors Q3`（1 source、1 accepted finding、1 report）。

## 接手后的第一批动作

1. 读 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) 第 4、7、12 节，确认角色、队列、里程碑。
2. 跑 `npm test` 与 `npm run build`，确认基线 72 / 通过。
3. 从 **M1** 开始：把 `task-queue.mjs` 接入 `local-api`，补任务 API 与测试。
4. M1 完成后再动 UI（任务页），避免先做界面再返工。
5. 任何新增写接口先写 `can(role, action)`，再写业务。

## 安全与合规

- 本地 Demo **没有认证**；LAN 内任何人可用并消耗 DeepSeek 额度。只在可信网络开放。
- `.env.host`、`.local/`、密钥、会话文件都不得提交。
- MCP stdio server 与插件执行任意代码，只允许 admin 安装；system 才可改 CLI。
- 抓取只针对公开页面，遵守 robots.txt / 站点条款，不绕登录、付费墙、验证码。
- `system` 角色不能被 Web 授予，避免管理员自升 T0。

## 如何交接

### 1. 代码与分支

当前工作区有大量未提交改动（新增 `server/agent-*`、`server/mineru.mjs`、`server/static.mjs`、`Dockerfile`、`deploy/`、`docs/*`、`evidence/ui-acceptance/` 等）。交接前先提交到一个分支：

```bash
git switch -c feature/task-loop-handoff
git add -A
git commit -m "Handoff: local demo, agent runtime, roles, deployment"
```

不要提交：`.env`、`.env.host`、`.local/`、`node_modules/`、`dist/`、日志。

### 2. 交接物

| 内容 | 方式 |
|---|---|
| 代码 | git 分支 / 补丁 |
| `seed/company-domel.json` | 已在仓库 |
| `.env.host` | 私下传递（DeepSeek key、MinerU token） |
| `.local/` 演示数据 | 可选；里面有真实研究项目，按需打包 |
| 验收截图 | `evidence/ui-acceptance/` 已提交 |
| 部署 | `Dockerfile`、`docker-compose.yml`、`deploy/domel-demo.service`、`docs/DEPLOYMENT.md` |

### 3. 接手验证基线

```bash
npm ci
npm test                  # 72 passed
npm run build
BASE=http://127.0.0.1:5174 npm run test:ui   # 49 passed, 需要 demo 在跑
curl -s http://127.0.0.1:8788/health
```

### 4. 阅读顺序

1. `docs/HANDOFF.md`（本文件）
2. `docs/IMPLEMENTATION_PLAN.md`（已确认的计划与里程碑）
3. `docs/DEPLOYMENT.md`（内网部署）
4. `docs/AGENT_RUNTIME.md`（MCP / Skills / 工作区）
5. `docs/DOCUMENT_PARSING.md`（MinerU 预定义）

### 5. 已知边界

- 任务队列、来源注册表、展会资料库、报销/参会推荐均未实现；按计划从 M1 开始。
- 研究仍走固定管线，不是 Agent 驱动。
- 角色是功能层权限；TLS、会话、加密、密钥托管不在本仓库范围。
- 本地 Demo 无认证，只用于可信内网。
- `system` 只能本地 CLI 设置；Web 降级后需 CLI 恢复 admin。

### 6. 下一步

按 `IMPLEMENTATION_PLAN.md`：M1 任务队列接入 → M2 任务页 → M3a/b/c 采集器与展会资料 → M4 插件/设置 UI → M5 Agent 页与验收。
