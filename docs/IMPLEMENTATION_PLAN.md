# 市场情报任务系统 · 实施计划 v3（展会资料优先，中国先做）

状态：**2026-11-03 M1–M5 已实现并验收**（见第 16 节实现结果）；下一阶段从第 15 节
的未完成项继续。本期实现细节见 [TASK_QUEUE.md](TASK_QUEUE.md)、
[EVENT_LIBRARY.md](EVENT_LIBRARY.md)、[AGENT_RUNTIME.md](AGENT_RUNTIME.md)、
[DOCUMENT_PARSING.md](DOCUMENT_PARSING.md)、[HANDOFF.md](HANDOFF.md)。
范围：单主机、单用户 Demo；先做中国市场。

## 1. 产品定位

**主流程：展会资料聚合。**

用户需要的是：快速找到与公司行业相关的展会，拿到可核验的参展资料，自己判断"去不去、参不参展"。
公司档案是**预置**的，不需要用户填写行业：以内置的 Domel 资料为准（[www.domel.com](https://www.domel.com)、[components.domel.com](https://components.domel.com)，中国实体「多麦机电（苏州）有限公司」）。展会发现、过滤和 Agent 提示都读取这份档案。

通用研究（项目、Insight、审核、报告）保留为底座能力，不再是首页主流程。

## 2. 目标与非目标

本期交付：

1. 持久化任务队列，统一调度展会发现、展会补全、来源采集、研究、Agent。
2. 来源注册表：来源是网址/栏目/RSS/Sitemap，不是已抓内容。
3. Node 采集器：HTTP → Readability → Playwright 回退 → Agent recipe。
4. 展会资料库：中国优先，覆盖未来 12 个月，字段可核验、可导出。
5. 四级角色：system(T0) / admin / user / viewer。
6. 前端：展会、任务、来源、项目、Agent、设置六个页面，简洁、中英双语。

非目标：

- 多用户登录 / RLS / 分布式部署。
- Python 爬虫、Scrapy、PostgreSQL（本期 Node + JSON）。
- 公网部署；本期部署在公司内网。
- 真实企查查 MCP 凭据（能力保留，凭据由管理员填）。

## 3. 当前状态（2026-11-03 更新：M1–M5 完成）

| 模块 | 状态 | 实现 |
|---|---|---|
| 本地 API、JSON 存储、项目/评审/报告 | ✅ 可用 | `local-api.mjs`、`local-store.mjs` |
| 研究管线、只读助手 | ✅ 可用 | `research-runner.mjs`、`assistant.mjs` |
| Agent 运行时（工作区 / MCP / Skills / CLI / 插件） | ✅ 后端 + Agent 页 | `agent-runtime.mjs`、`transcripts.mjs`、`src/Agent.tsx` |
| 持久任务队列（M1） | ✅ 已接入，含任务 API/SSE | `task-queue.mjs`、`task-runner.mjs` |
| 来源注册表（M3b） | ✅ 30 个中国来源种子 + 调度 + 每域限流 | `source-registry.mjs`、`scheduler.mjs`、`rate-limit.mjs`、`seed/sources-cn.json` |
| Node 采集器 / Playwright / recipe（M3a） | ✅ | `collector.mjs`、`recipes.mjs` |
| 展会资料库（M3c） | ✅ discover/enrich、去重、导出、文档可获取性 | `event-store.mjs`、`event-jobs.mjs`、`event-search.mjs` |
| 插件（Pi extension）（M4b） | ✅ 后端 + 设置页 UI | `agent-config.mjs`、`src/Settings.tsx` |
| 四级角色（功能层）（M4a） | ✅ 后端 + 设置页三态；传输安全不在本范围 | `permissions.mjs` |
| 设置页 | ✅ 角色/工具/OCR + MCP/Skills/Plugins/Recipes | `src/Settings.tsx` |
| 任务页 / 展会页 / 来源页 / Agent 页（M2/M5） | ✅ | `src/Tasks.tsx`、`Events.tsx`、`Sources.tsx`、`Agent.tsx` |
| 内置 Domel 公司档案 `seed/company-domel.json` | ✅ 已提交并测试 | `seed/` |
| MinerU 文档解析（M3d） | ⚠️ 配置/状态/接口已定义；真实解析未启用 | `mineru.mjs`、`docs/DOCUMENT_PARSING.md` |

## 4. 角色与权限

等级：`viewer(0) < user(1) < admin(2) < system(3)`。

| 能力 | system | admin | user | viewer |
|---|---|---|---|---|
| 查看展会、项目、证据、报告 | ✅ | ✅ | ✅ | ✅ |
| 创建任务（发现/补全/研究） | ✅ | ✅ | ✅ | ❌ |
| 审核 Insight、生成报告 | ✅ | ✅ | ✅ | ❌ |
| Agent 对话 | ✅ | ✅ | ✅ | ❌（只读历史） |
| MCP / Skills / 插件：开关 | ✅ | ✅ | ✅ | ❌ |
| MCP / Skills / 插件：增删改 | ✅ | ✅ | ❌ | ❌ |
| 角色切换（admin/user/viewer） | ✅ | ✅ | ❌ | ❌ |
| CLI / TUI / bash | ✅ | ❌ | ❌ | ❌ |
| 插件安装 / 卸载 | ✅ | ✅ | ❌ | ❌ |
| 手动修正展会资料 | ✅ | ✅ | ✅ | ❌ |

- `system` 只能通过本地 CLI/TUI 设置，Web 不出现、admin 不能授予。
- 写接口统一 `can(role, action)`，越权返回 403 + `requiredRole`。

## 5. 架构

```
React 前端
  ├─ 展会（首页）
  ├─ 任务  ← SSE
  ├─ 来源
  ├─ 项目
  ├─ Agent
  └─ 设置
                   │
Local API (Node) ──┴── Task Queue（JSON，单 worker）
                        ├─ scheduler.tick
                        ├─ event.discover
                        ├─ event.enrich
                        ├─ source.collect
                        ├─ project.research / extract
                        └─ agent.run（可见性）
                             │
        Event Store · Source Registry · Documents · Findings · Recipes
                             │
              Agent runtime（workspace / MCP / Skills / Plugins / CLI）
```

## 6. 数据模型

### Company Profile（预置）

| 字段 | 说明 |
|---|---|
| id / name / aliases | Domel / Domel Electric Motors / 多麦机电（苏州）有限公司 |
| website / productSite | www.domel.com / components.domel.com |
| industries[] | EC 电机、HVAC 通风、家电、电动出行、油泵驱动等（以官网产品线为准） |
| products[] / applications[] | 产品与典型应用 |
| markets[] | 欧洲、中国、北美等 |
| languages[] | en / zh / de / sl 等 |
| sources[] | 档案字段来源 URL 与抓取时间 |
| lastSyncedAt | 最近一次同步 |

档案由 Domel 官网抓取生成，人工可修正；用户不需要填写行业。

**内置种子**：`seed/company-domel.json` 已提交到仓库，应用、测试和演示默认加载它作为「我方公司」，保证展会对口。测试与演示可直接抓取 Domel 官网内容，单测使用保存的 HTML 快照。

### Event（展会）

| 字段 | 说明 |
|---|---|
| id / name / edition | 名称与届次 |
| startDate / endDate | ISO 日期；待确认时置空并标记 |
| city / country / venue | 城市、国家、展馆 |
| organizer / website | 主办方、官网 |
| frequency | 一年一届 / 两年一届等 |
| industries[] / scope | 行业与展品范围 |
| exhibitorCount / visitorCount / area | 上届规模，带来源 |
| exhibitorListUrl | 参展商名单链接 |
| exhibitorListStatus | linked / downloadable / restricted / unknown（是否可获取） |
| documents[] | `{url, type, status, parseProvider?, parsedAt?}` 官方 PDF/名单/手册 |
| competitors[] | 重点竞品是否参展、展位号（有来源才填） |
| applicationDeadline | 参展报名截止 |
| boothPrice / ticketPrice | 展位价格、门票价格 |
| sources[] | `{url, title, verifiedAt}` |
| confidence | high / medium / low |
| status | discovered / enriched / verified / archived |
| notes | 待确认、缺失说明 |

不提供"推荐参展/不参展"字段。

### Source Registry

| 字段 | 说明 |
|---|---|
| id / url / domain | URL 唯一；domain 用于限流 |
| type | venue / association / organizer / media / site / rss / sitemap |
| region | cn / eu / global |
| enabled / priority | 启停、P0–P3 |
| intervalSec | 最小 30 |
| lastRunAt / nextRunAt / status / lastError | 调度状态 |
| discoveredBy | human / agent |

### Task

| 字段 | 说明 |
|---|---|
| id / kind | `event.discover`、`event.enrich`、`source.collect`、`project.research`、`project.extract`、`agent.run` |
| projectId / eventId / sourceId | 关联，可空 |
| priority / state / attempts / notBefore | 调度 |
| progress / log / payload / result / error | 观测 |
| timestamps | createdAt / startedAt / finishedAt |

### Recipe / Plugin

- Recipe：`{id, domain, version, kind: selectors|script, body, status: proposed|approved|disabled}`。
- Plugin：`agent/extensions/<slug>/` + `{id, slug, name, enabled}`。

## 7. 任务队列

1. 单 worker、并发 1（可配置）。
2. 优先级 + 防饥饿：有效优先级 = 原始优先级 + 等待时长 / 5 分钟，封顶 P0。
3. 去重：同 `kind + projectId + eventId + sourceId` 存在 queued/running 时复用。
4. 限流：
   - 单来源间隔 ≥30s（需求硬下限，可调大，带 0–5s jitter）。
   - 每域令牌桶：容量 1，默认 5s 一个请求，取 `max(配置, robots Crawl-delay)`。
   - `429/503` 读 `Retry-After` 指数退避；`403/WAF` 暂停该域并标记人工确认。
   - 不设全局每分钟上限：部署在公司内网，出口带宽不是瓶颈。
   - 浏览器渲染并发固定 1（内存开销）。
5. 重试：5s / 30s / 2min，3 次后 failed；永久错误不重试。
6. 取消与恢复：排队直接取消；运行中标记并中止；重启 running → queued。
7. 事件：snapshot / task / task.log，SSE 推送，断线补快照。
8. 持久化：`.local/tasks.json`，原子写入。

## 8. 采集器（Node）

```
1. HTTP fetch（20s、2MB、content-type 校验）
2. Readability 正文抽取
3. 文本不足 / JS 壳 → Playwright（系统 Chrome，headless）
4. 仍不足或需要结构化字段 → agent.recipe
   - Agent 读取 HTML 快照，生成选择器/脚本
   - 快照上验证，写入 proposed recipe
   - admin 审批后启用，后续确定性复用
5. 规范化 → 哈希去重 → 入库
```

约束：公开页面、robots.txt、不绕登录/付费墙/验证码；recipe 子进程限时、无网络。

### 8.1 文档与 OCR（MinerU，预定义）

规则：**先给链接与"是否可获取"，不强行解析。**

- 每个 PDF/名单/手册记录：官方链接、类型、可获取状态（`linked` / `downloadable` / `restricted` / `unknown`）。
- 默认不下载、不 OCR；只有 `downloadable` 且管理员启用解析时才提交 MinerU。
- 解析器抽象 `server/mineru.mjs`，支持两种部署：
  - `official`：`MINERU_PROVIDER=official`、`MINERU_API_BASE=https://mineru.net/api/v4`、`MINERU_API_TOKEN=...`
  - `self-hosted`：`MINERU_PROVIDER=local`、`MINERU_LOCAL_URL=http://127.0.0.1:8000`（`mineru-kit api-server --port 8000`）；URL 允许任意 http(s) 主机/端口/路径，并可在设置中覆盖
- 配置只读接口 `GET /api/v1/ocr/status` 返回 `{provider, configured, baseUrl}`，绝不返回 token。
- token 由 admin 在网页设置中填写/替换，写入 `.local/agent-config.json`（0600），读取时只返回 `tokenSet`。
- 解析结果写回 `documents[].parsedAt/parseProvider`，失败保留链接与错误原因，不影响展会资料展示。
- 真实解析在 M3c 之后接入；本期先落配置、状态与接口定义。

> MinerU 官方文档：<https://mineru.net/apiManage/docs>；开源自部署：<https://github.com/opendatalab/MinerU>。

## 9. 展会数据流（中国优先）

### 预置来源（首批，均需逐一确认可抓取性）

| 类型 | 候选 |
|---|---|
| 公司官网 | `www.domel.com`（含 blog/新闻/展会回顾）、`components.domel.com`、sitemap；官网新闻中出现过的展会作为历史候选 |
| 展馆 | 国家会展中心（上海）、深圳国际会展中心、广交会展馆、中国国际展览中心、上海新国际博览中心 |
| 协会 | 中国制冷学会、中国建筑学会暖通空调分会、中国通用机械工业协会、中国电器工业协会 |
| 展会官网 | 中国制冷展、ISH China & CIHE、中国国际工业博览会、广交会、中国国际电机博览会 |
| 媒体 | 产业在线、冷暖商情、慧聪暖通 |

> 具体域名与页面在实现时逐个验证；抓不到的来源标记为 `manual`，不阻塞其他来源。

### 发现与补全

```
event.discover
  - 扫描来源注册表中 region=cn 的日历/列表页
  - 用预置 Domel 档案的关键词 + 中文实体名「多麦机电（苏州）」+ 展会 + 2026/2027 补充搜索
  - 产出候选：名称、官网、年份、来源
event.enrich
  - 抓官网，抽取第 6 节字段
  - 日期冲突/缺失标"待确认"，附来源
  - 去重：名称 + 日期 + 展馆
```

### 导出

- CSV：一行一个展会，字段扁平化。
- JSON：完整结构，含 sources。
- PDF 简报后续再加。

## 10. API

### 展会

```
GET  /api/v1/events?from=&to=&region=&status=&q=
GET  /api/v1/events/:id
POST /api/v1/events/discover          # 创建 event.discover 任务
POST /api/v1/events/:id/enrich        # 创建 event.enrich 任务
PATCH /api/v1/events/:id              # 手动修正（user+）
GET  /api/v1/events/export?format=csv|json

GET  /api/v1/ocr/status             # provider / configured / baseUrl
POST /api/v1/events/:id/parse       # 可选：对 downloadable 文档提交 MinerU
```

### 任务

```
GET  /api/v1/tasks?state=&projectId=&eventId=
GET  /api/v1/tasks/:id
POST /api/v1/tasks/:id/cancel
POST /api/v1/tasks/:id/retry
GET  /api/v1/tasks/stream             # SSE
```

### 来源 / 配置 / Agent（沿用并收紧角色）

```
GET/POST/PATCH/DELETE /api/v1/sources        # 读所有角色；开关 user+；增删改 admin+
POST  /api/v1/sources/:id/run                # user+ → 202 {task}
GET/POST/PATCH/DELETE /api/v1/agent/{mcp,skills,plugins}
PATCH /api/v1/agent/settings                 # role / cli（cli 仅 system）/ ocr
POST  /api/v1/agent/chat                     # SSE；viewer 403
GET   /api/v1/agent/sessions?projectId=      # viewer 只读（运行历史摘要）
GET   /api/v1/agent/sessions/:id             # viewer 只读 transcript
GET/POST/PATCH/DELETE /api/v1/recipes        # 读所有角色；增删改 admin+（recipes:manage）
POST  /api/v1/recipes/:id/test               # admin+：对真实页面执行 recipe
```

## 11. 前端

导航：**展会 · 任务 · 来源 · 项目 · Agent · 设置**。

### 展会（首页）

- 时间轴/列表切换；筛选：地区（默认中国）、时间（未来 6/12 个月）、状态、关键词。
- 卡片/表格：日期、名称、城市、展馆、资料完整度、竞品参展数、状态。
- 详情：第 6 节全部字段 + 官方链接 + 来源与核验时间 + 缺失说明。
- 操作：发现新展会、补全资料、手动修正、导出 CSV/JSON。

### 任务

计数、筛选、列表、详情/日志、取消/重试；SSE 实时。

### 来源

注册表表格：URL、类型、地区、优先级、间隔、下次运行、状态、开关、立即运行。

### 项目

保留进度、评审、证据、报告；内嵌项目任务列表；移除 HostQueue。

### Agent

项目/通用工作区、MCP/Skills 计数、对话流、工具卡片；viewer 只读历史。

### 设置

角色、CLI（system 可写，admin 只读）、MCP、Skills、插件、recipe 审批；按角色三态。

## 12. 里程碑

| 阶段 | 内容 | 验收 | 状态（2026-11-03） |
|---|---|---|---|
| M1 | 队列核心 + 任务 API + 测试 | 优先级、防饥饿、重试、去重、取消、重启恢复 | ✅ `tests/task-queue.test.mjs`（16）、`task-runner.test.mjs`（5）、`task-api.test.mjs`（5） |
| M2 | 任务页 + 研究接入 | 实时状态，可取消/重试 | ✅ `src/Tasks.tsx`，SSE + 轮询降级，浏览器验收通过 |
| M3a | Node 采集器（HTTP/Readability/Playwright） | 静态页、JS 壳页、超时、超大页、去重 | ✅ `tests/collector.test.mjs`（23，含真实 Chrome 回退）、`rate-limit`（9）、`recipes`（7） |
| M3b | 来源注册表 + 调度 + 每域令牌桶 | 30s、Crawl-delay、429 退避、启停 | ✅ 30 个种子来源；`tests/source-registry`（12）、`scheduler`（6） |
| M3c | 中国展会来源 + event.discover/enrich + 展会页 | 首批 20+ 来源；候选入库；核验；导出 | ✅ 30 来源；真实 discover 入库 10+ 事件、enrich 抓官网；官网自动查找（搜索候选→抓取匹配→首页优先）；国家/省/市/区县存储表推断；CSV/JSON 导出；相关测试 50+ |
| M3d | 文档可获取性 + MinerU 配置/状态/接口预定义 | 只给链接与状态；official/local 配置可读；不强行 OCR | ✅ probe 分类 + `POST /events/:id/parse` 预定义（未配置 409，已配置 501） |
| M4a | 四级权限 + 设置页三态 | 权限矩阵全绿 | ✅ `tests/permissions.test.mjs` + API 权限测试 + 浏览器角色三态 |
| M4b | 插件目录 + 管理 UI | 安装/卸载/开关；测试扩展可被调用 | ✅ 设置页 Plugins；`tests/agent-config`、`agent-mcp` |
| M5 | Agent 全功能页 + 浏览器验收 + 证据 | 交互全绿，0 console error | ✅ `src/Agent.tsx`、`transcripts.mjs`、`tests/agent-sessions.test.mjs`；浏览器 187 项 + API 174 项全 PASS，0 console/page error |

## 13. 测试（已实现）

- 单元：`tests/task-queue.test.mjs`（优先级/防饥饿/重试/去重/取消/持久化）、`rate-limit.test.mjs`、`recipes.test.mjs`、`event-store.test.mjs`、`event-jobs.test.mjs` 等。
- 采集：`tests/collector.test.mjs` 用注入 fetch + HTML 快照；Playwright 用本地 node:http JS 壳页 + 系统 Chrome（缺失自动 skip）；不依赖实时网络。
- 公司档案：`tests/company-seed.test.mjs` 校验内置 Domel 档案的别名、产品线、关键词与来源 URL。
- 接口：`tests/task-api/events-api/sources-api/recipes-api/agent-sessions.test.mjs`（任务列表/详情/取消/重试/SSE/权限矩阵/来源 CRUD/展会导出/Agent 历史）。
- 集成：`tests/task-runner.test.mjs`（队列 + 研究 job 生命周期 + source.collect + discover/enrich + scheduler）。
- 浏览器：`scripts/ui-acceptance.mjs`（六页 + 角色三态 + 移动端 + i18n，0 console/page error）。
- API 验收：`scripts/acceptance-api.mjs`（health/capabilities/任务/展会/来源/recipes/sessions/角色矩阵/生产模式）。
- 证据：`evidence/ui-acceptance/` 截图与清单。

## 14. 风险

| 风险 | 处理 |
|---|---|
| 中国展会站点 JS/反爬 | Playwright + recipe + 人工来源；标注抓取失败 |
| 日期频繁调整 | 只信官网；冲突标待确认；保留核验时间 |
| 展商名单在 PDF/图片 | 先提供链接与"是否可获取"，不强行 OCR |
| Playwright 依赖浏览器 | 系统 Chrome；缺失时提示安装 |
| 单 worker 慢 | 优先级 + 防饥饿；并发可调 |
| JSON 并发写 | 单进程串行 + 原子替换 |
| 角色自升权 | system 仅本地 CLI；admin 不能授予 system |

## 15. 假设与待确认

- 先做中国大陆展会；港澳台与海外后续加 region。
- 公司档案固定为 Domel，不提供行业输入；行业范围以官网产品线为准。
- 展商名单：优先完整名单；拿不到时只标"重点竞品是否参展"。
- 导出先 CSV + JSON，PDF 简报后续。
- 企查查 MCP 由管理员提供命令/URL 与凭据。
- MinerU 默认关闭；官方 API 依赖 token，自部署依赖独立服务与 GPU；两者都由管理员配置。
- 部署在公司内网单主机，不做全局吞吐上限。

## 16. 实现结果与偏差（2026-11-03）

相对本计划的实现差异，均已在 HANDOFF 记录：

1. **M3c 数据规模**：真实 discover 每次产出约 10–20 条候选（受模型返回与 limit 控制），
   去重合并后入库；"首批 20 个来源"已超额（30 个）。候选/核验数量由真实网络与模型
   决定，没有为了凑数写入虚构展会。
2. **研究接入方式**：`project.research`/`project.extract` 进入统一队列，但执行的仍是
   固定研究管线（不是 Agent 驱动），这是计划内的 M5 之后事项。
3. **M3d**：只实现"配置/状态/接口预定义 + 文档可获取性"，真实 MinerU 解析按计划留到后续。
4. **M4a 权限**：功能层权限完成；传输安全、登录、加密不在本期（计划已声明）。
5. **前端**：六个页面全部落地；项目研究页保留在 "项目" 导航下；原 Data sources 页被
   来源注册表页取代。
6. **额外能力**：任务 SSE 断线补快照、任务页轮询降级、Agent 运行历史、展会 URL
   HTML 实体解码、历史届次提示、同官网不同名合并——这些是验收中发现问题后的修复。

## 17. 迭代（2026-11-03）：地理层级与官网补全

用户复核发现：展会详情里国家/地区为空、部分展会没有官网、来源 URL 不可见。处理如下：

1. **存储式地理表**：新增 `seed/geo-cn.json`（国家/省/市/区县 + 展馆层级）与
   `server/geo.mjs`。事件国家/省/市/区县从城市/展馆表推断，不再用事件名正则猜测；
   `MarketEvent` 新增 `province` / `district` 字段（API/UI/CSV 导出均包含）。
2. **官网补全**：`event.enrich` 在没有官网/来源时通过 DeepSeek Web Search 找候选，
   抓取页面并校验标题/字段与事件名匹配后才写入 `website`；优先站点首页而非
   contact/about 深层页；抓不到时把候选 URL 写进 notes 待人工确认。
3. **来源 URL 可见**：展会详情“已核验来源/文档”直接显示 URL 文本（可点击），不再只显示标题。
4. **旧数据补齐**：`scripts/backfill-event-geo.mjs`（`npm run event:backfill-geo`）离线
   补齐旧事件的国家/省/市/区县并清理过期的“缺少官网”notes。
5. 新增测试 `tests/geo.test.mjs`、`tests/event-jobs-website.test.mjs`；全量测试 230、
   浏览器 187、API 175 均通过（2026-11-03 重跑）。
6. **境外自办展识别**：`中国（阿联酋）贸易博览会`、`China (UAE) Trade Expo` 这类名称里的
   "中国"是主办方/货源地，括号里的国家和城市才是举办地。`server/geo.mjs` 解析名称括号，
   命中存储的国家/城市后把事件归到 `global`/`eu` 区域并在 notes 说明；已入库的旧记录在
   enrich 时自动纠正。测试 `tests/event-jobs-overseas.test.mjs`；全量测试 234。

## 18. 迭代（2026-11-03）：UI 配置 AI 模型

用户要求“本地部署的 AI 可填入提供自定义方式”。实现：

1. 设置页新增 **AI 模型** 区块（admin）：API Key（只写不读）、模型名、Base URL。
   保存在 `.local/agent-config.json`（0600），优先于 `.env.host`；保存后懒加载重建
   模型会话，无需重启。
2. Base URL 为空或 `api.deepseek.com` → DeepSeek 官方；其他地址视为 OpenAI 兼容的
   本地部署（Ollama/vLLM/LM Studio/内网网关），Agent、只读助手、抽取都切到该模型。
   本地模型没有 DeepSeek search/fetch 工具，展会发现退回注册表扫描、补全跳过官网搜索。
3. 研究抽取通过同步 `AI_BASE_URL/AI_API_KEY/AI_MODEL` 使用自定义模型；可用
   `CUSTOM_AI_CONTEXT_WINDOW` / `CUSTOM_AI_MAX_TOKENS` 调整本地模型上下文。
4. 测试 `tests/llm-settings.test.mjs`（配置存储/脱敏、admin/viewer 权限、capabilities、
   运行期取 key、custom provider 构建）；全量 239。验收：浏览器 193、API 179，
   0 console/page error。

## 19. 迭代（2026-11-03）：官网搜索与本地搜索引擎

用户发现某展会“官方网站”被写成论坛帖子（eechina/eeworld thread）。处理：

1. **官网质量门**：新增 `isLikelyOfficialUrl`，拒绝论坛/媒体/目录/文章页（`/thread`、
   `/bbs`、`/news`、`/article`、`/contact`、`/download` 等）及 UGC/媒体域名；只接受
   站点根/落地页。搜索候选页在抓取匹配之外还要通过该检查，才可写入 `website`。
2. **旧数据清理**：`scripts/clean-event-websites.mjs`（`npm run event:clean-websites`）离线
   清理历史错误官网，并尝试从 `sources` 恢复可用官网；补全时也会自动清除/升级旧错误值。
3. **可插拔搜索**：`server/web-search.mjs` + `WEB_SEARCH_PROVIDER=auto|deepseek|searxng|custom|none`，
   支持本地部署 SearXNG（JSON API）、内部 JSON 搜索网关、DeepSeek 搜索工具；配置见
   `docs/SEARCH_ENGINES.md`（含 Docker Compose 与 settings.yml 示例）。
4. 测试 `tests/web-search.test.mjs`（7 个）：官网质量门、SearXNG/Custom 适配器、provider
   选择、论坛结果拒绝、旧官网清理/恢复。

## 20. 迭代（2026-11-03）：技能封装 + Agent 驱动研究

用户要求把相关内容封装为 skills 供 Agent 调用，并要求研究过程实际调用 Agent。

1. **内置技能包** `seed/skills/`：`domel-api`（本地 API curl 手册）、
   `event-intelligence`（展会发现/官网规则/往届日期）、`source-collection`
   （来源注册表/采集器/安全单页抓取）、`evidence-quality`（逐字引文/不编造）、
   `agent-research`（研究流程与 `research-result.json` 契约）。新数据目录自动导入
   `.local/agent/skills/`，设置页可见、Agent 会话加载。
2. **Agent 驱动研究**：项目页新增「Agent 研究」（`run mode=agent`），队列任务
   `project.agent-research`；Agent 用 skills + bash/curl 实际调用本地 API/抓公开页，
   写 `research-result.json`；服务端校验公开 HTTPS 来源、项目竞品/focus、逐字引文后
   入库为待审核 findings，不合格引文直接丢弃。
3. **真实回归**：本机 demo 跑通一次 Agent 研究：3 个来源、9 条 findings、0 丢弃，
   任务 ~2.5 分钟完成并进入审核状态。
4. 测试 `tests/agent-research.test.mjs`（7 个）：prompt 契约、校验/丢弃、JSON 解析、
   文件/文本回退、技能种子导入、API mode=agent 任务编排；全量 253 passed。
