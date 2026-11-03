# 交接文档（2026-11-03，M1–M5 完成）

本文件面向接手这个仓库的下一位开发者 / Agent。先读「一分钟概览」和「先跑起来」，再读计划与契约。

## 一分钟概览

- 这是一个**单用户本地 Demo**：React 前端 + Node 本地 API + `.local/` JSON 数据，无需 Supabase、无需登录。
- 产品主流程是**展会资料聚合（中国优先）**：找到相关展会、提供可核验的日期/展馆/报名截止/展位价格/竞品参展等资料，由公司自行判断去不去、参不参展。
- 公司档案是**预置**的（Domel，官网 www.domel.com，中国实体「多麦机电（苏州）」），用户不需要填写行业。
- 本期已交付 **M1–M5**：持久任务队列 + 任务 API/SSE、任务页、Node 采集器（HTTP/Readability/Playwright/recipe）、来源注册表 + 调度 + 每域限流、中国展会资料库（discover/enrich + 展会页 + 导出）、设置页 MCP/Skills/Plugins/Recipes、Agent 页与运行历史、四级角色。研究流程（项目 → 来源 → Insight → 审核 → 报告）保留为底座能力。
- 已确认的计划在 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)；模块细节见 [TASK_QUEUE.md](TASK_QUEUE.md)、[EVENT_LIBRARY.md](EVENT_LIBRARY.md)、[AGENT_RUNTIME.md](AGENT_RUNTIME.md)、[DOCUMENT_PARSING.md](DOCUMENT_PARSING.md)。

## 当前状态

| 模块 | 状态 | 位置 |
|---|---|---|
| 本地 API、JSON 存储、项目/评审/报告、研究管线、只读助手 | ✅ | `server/local-api.mjs`、`local-store.mjs`、`research-runner.mjs`、`assistant.mjs` |
| 持久任务队列（优先级/防饥饿/重试/去重/取消/重启恢复/SSE） | ✅ | `server/task-queue.mjs`、`task-runner.mjs` |
| 任务 API + 任务页 | ✅ | `local-api.mjs`、`src/Tasks.tsx` |
| Node 采集器（HTTP→Readability→Playwright→recipe） | ✅ | `server/collector.mjs` |
| 每域限流/robots/Crawl-delay/429 退避/403 暂停 | ✅ | `server/rate-limit.mjs` |
| 来源注册表 + 调度器 + 30 个中国来源种子 | ✅ | `server/source-registry.mjs`、`scheduler.mjs`、`seed/sources-cn.json` |
| 展会资料库 + discover/enrich + 去重 + 文档可获取性 + 导出 | ✅ | `server/event-store.mjs`、`event-jobs.mjs`、`event-search.mjs`、`src/Events.tsx` |
| 来源页、设置页 MCP/Skills/Plugins/Recipes | ✅ | `src/Sources.tsx`、`src/Settings.tsx` |
| Agent 页 + 运行历史（viewer 只读） | ✅ | `src/Agent.tsx`、`server/transcripts.mjs` |
| 四级角色 viewer/user/admin/system（功能层） | ✅ | `server/permissions.mjs` |
| MinerU 文档解析 | ⚠️ 配置/状态/parse 路由已定义；真实解析未启用（M3d 边界） | `server/mineru.mjs`、`docs/DOCUMENT_PARSING.md` |
| Agent 自适应抓取（recipe 自动生成/审批后复用） | ⚠️ 存储/沙箱/审批可用；Agent 自动提出流程未接 | `server/recipes.mjs` |
| 登录 / TLS / 存储加密 / 多用户 | ❌ 不在本仓库范围 | — |
| 任务队列换 Postgres/分布式 | ❌ 未做；接口已隔离 | `task-queue.mjs` |

## 先跑起来

环境：Node ≥ 22.19（本机 22.23），Chrome（Playwright 回退用，可不装）。

```bash
cd domel-market-intelligence
npm ci

# .env.host（服务端密钥，已忽略提交）
# DEEPSEEK_API_KEY=sk-...
# DEEPSEEK_MODEL=deepseek-flash   # 可选

npm run demo:api        # API: http://127.0.0.1:8788（含队列/调度器）
npm run dev             # 前端: http://127.0.0.1:5174
```

局域网演示：`npm run demo:lan`（API+前端都绑 0.0.0.0，打印地址）。

测试、构建与验收：

```bash
npm test                                          # 255 个 Node 测试
npm run build                                     # tsc + vite

# 独立验收（脚本会准备隔离数据，不写仓库 .local/）：
node scripts/acceptance-api.mjs --prepare         # 准备 /tmp/domel-acceptance
# 起 API 8791 + vite 5176（VITE_BACKEND_URL=http://127.0.0.1:8791）后：
BASE=http://127.0.0.1:5176 API_BASE=http://127.0.0.1:8791 \
  ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance npm run test:ui
API_BASE=http://127.0.0.1:8791 ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance npm run test:api
```

没有 `.env.host` 时：页面可用、审核与报告可用、来源采集可用；但研究、展会发现/补全、Agent 会返回配置错误。

## 六个页面

导航：**展会 · 任务 · 来源 · 项目 · Agent · 设置**（默认首页是展会）。

- **展会**：筛选（地区默认中国、未来 6/12 个月/全部、状态、关键词）、列表/时间轴、详情（全部字段、来源与核验时间、缺失说明、文档 availability）、发现/补全（创建任务）、手动修正、导出 CSV/JSON。
- **任务**：统计、筛选、列表/详情（payload/result/error/日志时间线）、取消/重试，SSE 实时 + 3s 轮询降级。
- **来源**：注册表 CRUD、启停、立即运行、调度状态；admin 增删改、user 只能开关、viewer 只读。
- **项目**：研究项目列表与进度/证据/审核/报告；只读助手保留。
- **Agent**：项目/通用工作区对话、工具卡片、中途中止、运行历史（viewer 只读历史）。
- **设置**：角色三态、Agent 工具（system 可写）、MCP（raw JSON/连接测试）、Skills、Plugins、Recipes 审批、MinerU OCR。

## 目录与关键文件

```
server/
  local-api.mjs        HTTP/SSE 路由、角色检查、静态服务、主进程接线
  local-store.mjs      项目/来源摘录/发现/审核/报告 JSON 存储
  research-runner.mjs  研究管线适配（原 local-api 内联逻辑抽出）
  task-queue.mjs       持久任务队列核心
  task-runner.mjs      队列 + research/source/event handlers + scheduler 接线
  collector.mjs        HTTP→Readability→Playwright→recipe 采集链
  rate-limit.mjs       每域令牌桶/Crawl-delay/退避
  recipes.mjs          recipe 存储 + vm 沙箱执行
  source-registry.mjs  来源注册表 + 种子导入
  scheduler.mjs        到期来源 → source.collect
  documents.mjs        采集页面存储（URL 去重）
  event-store.mjs      展会资料库 + 导出（含 province/district）
  event-jobs.mjs       event.discover / event.enrich handlers（官网查找/首页优先/地理推断）
  geo.mjs              国家/省/市/区县存储表推断（seed/geo-cn.json）
  event-search.mjs     DeepSeek JSON 发现 + 注册表扫描兜底
  agent-config.mjs     MCP/Skills/Plugins/角色/CLI/OCR 配置
  agent-runtime.mjs    Pi Agent 会话（文件/Shell/MCP/Skills/插件）
  transcripts.mjs      Agent 运行历史
  static.mjs           生产静态服务
  mineru.mjs           OCR 配置/状态/可获取性预定义
  assistant.mjs        只读助手 + DeepSeek 模型初始化

src/
  App.tsx              页面路由/导航/项目研究页（单文件）
  Events.tsx           展会首页
  Tasks.tsx            任务页
  Sources.tsx          来源页
  Agent.tsx            Agent 页
  Settings.tsx         设置页（角色/工具/OCR/MCP/Skills/Plugins/Recipes）
  api.ts               新 API 的唯一客户端（任务/展会/来源/recipes/Agent）
  types.ts             共享类型
  i18n.tsx             中英词典 + registerMessages（页面模块自行注册词条）
  data.ts              项目研究数据层（local/host/demo）
  messages-*.ts        新页面词条
  tasks-sources.css / events-agent.css  新页面样式

tests/                 255 个 Node 测试
tests/fixtures/        可执行 mock MCP server、API fakes、HTML/事件 fixtures
scripts/               demo:lan、ui-acceptance、acceptance-api、agent-admin、pi spike
evidence/ui-acceptance/ 浏览器验收截图与清单
seed/                  company-domel.json、sources-cn.json、geo-cn.json
docs/                  HANDOFF/IMPLEMENTATION_PLAN/TASK_QUEUE/EVENT_LIBRARY/AGENT_RUNTIME/
                       DOCUMENT_PARSING/DEPLOYMENT/TEAM_CONTRACTS/HOST_API(历史)…
```

数据目录（全部被 git 忽略）：

```
.local/domel.json               项目、来源摘录、发现、报告
.local/tasks.json               任务队列（重启恢复）
.local/events.json              展会资料库
.local/source-registry.json     来源注册表（首次从 seed/sources-cn.json 导入 30 个）
.local/documents.json           采集到的页面
.local/recipes.json             recipes
.local/agent-config.json        角色、CLI、OCR、skills/plugins 元数据（0600）
.local/agent/mcp.json           MCP 配置（0600）
.local/agent/transcripts.json   Agent 运行历史
.local/agent/skills/<slug>/SKILL.md
.local/agent/extensions/        插件
.local/agent/sessions/          Pi 会话
.local/workspaces/<project>/    Agent 工作区
.local/assistant/               只读助手会话
```

## 已验证的能力（证据）

| 能力 | 证据 |
|---|---|
| 任务队列 | `tests/task-queue.test.mjs` 16 用例；`tests/task-runner.test.mjs` 5 个集成用例；`tests/task-api.test.mjs` |
| 采集器 | `tests/collector.test.mjs` 23 用例（含本地 JS 壳页真实 Chrome 回退）；`tests/rate-limit.test.mjs`、`recipes.test.mjs` |
| 来源/展会 | `tests/source-registry/scheduler/documents/event-store/event-jobs.test.mjs`；真实 discover 14 条候选、enrich 抓官网成功（2026-11-03） |
| 展会官网补全 | enrich 对无官网事件用 DeepSeek 搜索候选、抓取匹配后写入官网（优先首页）；`tests/event-jobs-website.test.mjs`；演示库 27/31 事件有官网 |
| 地理层级 | 国家/省/市/区县由 `seed/geo-cn.json` 存储表推断（`server/geo.mjs`，无正则）；`tests/geo.test.mjs`；`scripts/backfill-event-geo.mjs` 可离线补齐旧数据 |
| 境外自办展 | `中国（阿联酋）贸易博览会`/`China (UAE) Trade Expo` 等按名称括号里的国家/城市归类为境外（region=global/eu），加"名称含中国但举办地在境外"notes；`tests/event-jobs-overseas.test.mjs` |
| AI 模型 UI 配置 | 设置 → AI 模型填 Key/模型/Base URL（只写不读，0600，即时生效）；自定义 Base URL 切到本地 OpenAI 兼容模型；`tests/llm-settings.test.mjs`（5 用例） |
| Agent 技能包 + Agent 研究 | `seed/skills/` 5 个技能（domel-api、event-intelligence、source-collection、evidence-quality、agent-research）新数据目录自动导入；项目页「Agent 研究」→ `project.agent-research` 任务，Agent 用 bash/curl 调本地 API 收集网页并写 `research-result.json`，服务端校验引文/竞品/focus/公开 URL 后入库待审核；`tests/agent-research.test.mjs`（7 用例） |
| 前端自动化质量矩阵 | `npm run test:frontend`：自动起隔离 API/Vite，覆盖 6 页 × 2 语言 × 2 视口 + admin/user/viewer + 500/空状态 + 键盘/skip link/dialog/语言切换/文档标题/可达结构；**168 项全 PASS**，产出截图与 `evidence/frontend-quality/REPORT.md`；静态 i18n 覆盖在 `npm test`；CI 工作流 `.github/workflows/frontend-quality.yml` |
| 真实 DeepSeek 研究 | 2026-11-03：9 个候选 URL，抓 5 页，1 条 finding，状态 partial |
| 只读助手 SSE | 真实模型 0.7s 返回；项目问题会调用 `list_findings` 并引用 Nidec |
| Agent + MCP | 配置 stdio mock server 后，真实模型调用 `mcp__mock__echo` 得到 `echo:hello from mcp` |
| Agent + 历史 | 真实 DeepSeek 对话一次，`agent/transcripts.json` 记录 user/assistant/toolCalls；`/api/v1/agent/sessions` 可读 |
| 浏览器验收 | **197 项 PASS / 0 FAIL**，0 console/page error；六页 + 角色三态 + 中英 + 390×844 移动端；展会详情含国家/省/市/区县与可点击官网/来源 URL（见 `evidence/ui-acceptance/UI_ACCEPTANCE.md`） |
| API 验收 | **179 项 PASS / 0 FAIL**（任务/展会/来源/recipes/Agent 历史/权限矩阵/CORS/生产模式契约）（见 `evidence/task-loop/API_ACCEPTANCE_2026-11-03.log`） |
| 测试/构建 | `npm test` 255/255；`npm run build` 通过 |
| 生产模式 | 带同源 Origin：`/health` 200、`/` 构建产物、`/assets/*.js|css` 200、SPA 回退、`/api/v1/workspace` 200；`evil.test` Origin 访问 API 403（见 `evidence/task-loop/PRODUCTION_CHECK_2026-11-03.md`） |

## 未完成 / 半成品（不要当成已交付）

1. **MinerU 真实解析未启用**：`POST /api/v1/events/:id/parse` 对已配置且 downloadable 的文档返回 501，只登记链接与可获取性；后续按 [DOCUMENT_PARSING.md](DOCUMENT_PARSING.md) 的步骤实现（新增任务 kind `document.parse`）。
2. **Agent 自适应抓取未闭环**：recipe 的存储/沙箱/审批/复用已实现，但还没有"失败页 → Agent 读取 HTML 快照 → 提出 recipe → 管理员审批"的自动流程与 UI 入口。
3. **研究仍非 Agent 驱动**：`project.research` 走固定管线（DeepSeek Search/Fetch/Extraction），未由 Pi Agent 自主调用工具完成。
4. **没有 PDF 简报导出**：只有 CSV/JSON/浏览器打印。
5. **任务队列仍是单进程 JSON**：换 Postgres/分布式队列只需替换 `task-queue.mjs`，但未做。
6. **企查查 MCP 只有能力**：没有真实 server 凭据；管理员需自行提供。
7. **登录/传输安全/加密/多用户**：按安排由专项模型处理，不在本仓库。
8. **公开 API 文档**：HOST_API.md 是旧 host 路线；新的本地 API 目前以 `docs/TASK_QUEUE.md`、`EVENT_LIBRARY.md`、源码为准，没有 OpenAPI。

## 关键决策（已确认）

- **爬虫用 Node**，不引入 Python：Node fetch/Playwright 足够；Playwright 用系统 Chrome。
- **Agent 自适应抓取用 recipe**：`script`（vm 沙箱）/`regex`/`selectors`，admin 审批后确定性复用。
- **四级角色**：viewer < user < admin < system；system 只能本地 CLI，Web 不可授予。
- **单 worker、单 JSON**：本机 Demo 够用；接口留好，后续换 Postgres/分布式。
- **插件 = Pi extension**：`agent/extensions/<slug>/`，admin 安装/卸载，user 开关，viewer 只读。
- **Agent 能力默认全开**：文件读写/Shell/MCP/Skills/插件默认启用；T0 可显式关闭。
- **地理用存储表**：国家/省/市/区县来自 `seed/geo-cn.json` 的城市/展馆表，不用名称正则猜测。
- **官网补全**：enrich 先查已有官网/来源；没有时用搜索候选，抓取并匹配事件名后才写入官网，优先站点首页。
- **境外自办展**：名称里的"中国"表示主办/货源地，括号里的国家/城市才是举办地；按存储地理表归类，不按名称关键词猜国内。
- **AI 模型可配置**：设置页 admin 可填 DeepSeek Key / 模型 / Base URL；Base URL 非 `api.deepseek.com` 时视为本地 OpenAI 兼容模型（Agent/助手/抽取切到它）。Key 只写不读、服务端 0600、优先于 `.env.host`、保存后即时生效。
- **展会资料只列事实与来源**，不提供"推荐参展/不参展"。
- **来源是网址注册表**，不是已抓内容；研究和采集分开存储。

## 已知坑

1. **MCP 子进程继承工作区 cwd**：`command`/`args` 用相对路径会静默启动失败，必须绝对路径；失败只写 `agent/mcp.log`，聊天流看不到。
2. **MCP 工具排除规则**：会话 `tools` 允许列表必须包含 `mcp__*`；`noTools: "builtin"` 会保留扩展工具。
3. **`bindExtensions` 必须调用**：MCP 在 `session_start` 才连接；SDK 默认不会自动绑定。
4. **非安全上下文没有 `crypto.randomUUID`**：LAN HTTP 下已有降级；新代码不要直接调用。
5. **i18n 以英文原文为 key**：新界面文案必须补中文；新页面用 `registerMessages({...})` 在模块顶层注册，不要改共享词典（避免并行冲突）。后端通知走 `src/notices.ts`。
6. **角色检查先于业务**：新增写接口先写 `can(role, action)`，403 返回 `{error, requiredRole}`；viewer 只读、user 只能开关/建任务、admin 增删改、CLI 仅 system。
7. **测试里的 agent 会话会拉起 MCP 子进程**：用子进程 + `process.exit` 隔离（见 `tests/agent-mcp.test.mjs`），不要在同一个测试进程里长期挂 MCP。
8. **Demo 数据会污染验收**：跑 UI/API 验收或实验后，停止 API、删 `.local/`（或换成独立数据目录）可重置；`.local/` 不进 git。
9. **任务队列不自动启动**：`createTaskRunner` 后必须 `start()`；`queue.cancel` 对 running 任务返回时仍是 `running + cancelRequested`，handler settle 后才变 `cancelled`；`queue.idle()` 超时会 reject。
10. **Playwright 依赖系统 Chrome**：没有 Chrome 时采集器只做 HTTP 回退（不 fatal）；Docker 镜像默认没有 Chrome。
11. **每域限流是进程内状态**：重启清空；单来源间隔写在注册表 `intervalSec`（≥30s）；403/WAF 会 `paused`，需人工恢复。
12. **URL/域名规范化**：recipe 的 domain 用 hostname（不带 www）；同官网不同展示名的展会在 `event-store.upsert` 里合并；HTML 实体在 URL 规范化时解码。
13. **展会 enrich 可能抽到上一届日期**：会写 notes 提示"下一届待确认"，未来筛选时注意。
15. **官网候选不等于官网**：搜索候选只有抓取页面且标题/字段匹配事件名后才写入 `website`；抓不到时写入 `官网候选（待人工确认）` note。人工修正优先。
16. **地理推断依赖 seed/geo-cn.json**：新增展会城市/展馆时先补表；旧数据升级后跑 `npm run event:backfill-geo`（需停服务）。
17. **"中国（X）"不代表在中国**：境外自办展名称里的中国是主办方/货源地；geo 会按括号国家/城市归类为境外并写 note。新增国家/城市时补 `seed/geo-cn.json` 的 countries/cities。
18. **自定义 AI 模型能力有限**：本地 OpenAI 兼容模型没有 DeepSeek 的 search/fetch 工具，`search` 能力会被关闭 → 展会发现退回注册表页面扫描；研究抽取走 `AI_BASE_URL/AI_API_KEY/AI_MODEL`（由设置同步到进程环境）。若模型不支持 tool calling，Agent 页能用但工具调用会失败。
19. **官网搜索需要搜索引擎**：补全用 `WEB_SEARCH_PROVIDER`（auto/deepseek/searxng/custom/none）找官网候选；本地部署用 SearXNG（见 `docs/SEARCH_ENGINES.md`）。搜索结果只是候选：论坛/媒体/目录页会被拒绝，必须抓取页面且与事件名匹配才写入 `website`；历史错误官网用 `npm run event:clean-websites` 清理。
14. **单 `.local/` 只能一个进程**：两个实例会互相覆盖 JSON 与队列。

## 接手第一小时

```bash
cd domel-market-intelligence
npm ci
npm test                       # 期望 255 passed
npm run build
npm run demo:api               # API 8788
npm run dev                    # 前端 5174
# 独立验收（隔离数据，见「先跑起来」段的完整命令）：
node scripts/acceptance-api.mjs --prepare
# 起 8791 API + 5176 vite 后：
BASE=http://127.0.0.1:5176 API_BASE=http://127.0.0.1:8791 \
  ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance npm run test:ui
API_BASE=http://127.0.0.1:8791 ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance npm run test:api
```

生产模式：

```bash
npm run serve                  # build + 单进程 UI+API
# 或 Docker：docker compose up -d
```

## 阅读顺序

1. `docs/HANDOFF.md`（本文件）
2. `docs/IMPLEMENTATION_PLAN.md`（已确认范围与 M1–M5）
3. `docs/TASK_QUEUE.md`、`docs/EVENT_LIBRARY.md`（新模块）
4. `docs/DEPLOYMENT.md`（内网部署）
5. `docs/AGENT_RUNTIME.md`（MCP/Skills/Plugins/角色/历史）
6. `docs/DOCUMENT_PARSING.md`（MinerU 边界）
7. `docs/TEAM_CONTRACTS.md`（并行开发接口契约，可作为二次开发参考）

## 如何交接

### 1. 代码与分支

本期改动已在分支 `feature/task-loop-handoff` 上提交（基线交接 commit + M1–M5 实现 commit）。
交接前确认：

```bash
git status                 # 干净
git log --oneline -5
```

不要提交：`.env`、`.env.host`、`.local/`、`node_modules/`、`dist/`、日志。

### 2. 交接物

| 内容 | 方式 |
|---|---|
| 代码 | 分支 / 补丁 |
| `seed/company-domel.json`、`seed/sources-cn.json` | 已入库 |
| `.env.host` | **私下传递**（DeepSeek key、MinerU token） |
| `.local/` 演示数据 | 可选；含真实研究项目、展会资料、任务、Agent 历史 |
| 验收截图/清单 | `evidence/ui-acceptance/` 已入库 |
| 部署文件 | `Dockerfile`、`docker-compose.yml`、`deploy/domel-demo.service`、`docs/DEPLOYMENT.md` |

### 3. 关键边界

- 只部署在**可信内网**，无认证、无 TLS。
- 同一份 `.local/` 只能一个进程。
- `system` 只能本地 CLI 设置；Web 降级后需 `npm run agent:admin -- role admin` 恢复。
- 安全/加密相关交由专项模型，不在本仓库继续扩展。
- 抓取遵守 robots.txt/站点条款，不绕登录、付费墙、验证码。

### 4. 下一步（优先级建议）

1. **M3d 真实解析**：MinerU 任务化（`document.parse`），只对 downloadable + 管理员启用；失败不影响链接展示。
2. **Agent 自适应抓取闭环**：失败页快照 → Agent 生成 recipe → 设置页审批 → 确定性复用；补 UI 入口与测试。
3. **Agent 驱动研究**：让 Agent 通过工具（source registry/collector/event store）执行研究，而不是固定管线。
4. **展会数据质量**：来源增加日历页/RSS/sitemap 解析器；日期冲突与历史届次处理；批量核验与导出模板。
5. **PDF 简报导出**：基于已有报告快照。
6. **多用户/认证/加密**：按专项计划，不在本期。
