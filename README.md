# Domel Market Intelligence

面向 Domel（多麦机电）的**展会资料聚合与市场研究工作台**：找到相关展会、拿到可核验的
日期/展馆/报名截止/展位价格/竞品参展等资料，由公司自行判断去不去、参不参展；研究项目
（来源 → Insigh → 审核 → 报告）保留为底座能力。

单用户本地 Demo：React 前端 + Node 本地 API + `.local/` JSON 数据，无需 Supabase、无需登录。
**只在可信内网使用**，没有 TLS/登录/限流。

## 当前状态（2026-11-03，M1–M5 完成）

| 能力 | 状态 |
|---|---|
| 持久任务队列（优先级/防饥饿/重试/去重/取消/重启恢复）+ 任务 API/SSE | ✅ |
| 任务页（统计、筛选、详情日志、取消/重试、SSE 实时） | ✅ |
| Node 采集器：HTTP → Readability → Playwright（系统 Chrome）→ recipe | ✅ |
| 来源注册表 + 调度器 + 每域令牌桶/robots/Crawl-delay/429 退避/403 暂停 | ✅ 30 个中国来源种子 |
| 展会资料库：`event.discover` / `event.enrich`、去重合并、文档可获取性、CSV/JSON 导出 | ✅ |
| 展会页（首页）：列表/时间轴、筛选、详情、发现/补全/手动修正/导出 | ✅ |
| 来源页、Settings 的 MCP/Skills/Plugins/Recipes 管理 | ✅ |
| Agent 页：SSE 对话、工具卡片、可中断、运行历史；viewer 只读历史 | ✅ |
| 四级角色 viewer/user/admin/system（功能层） | ✅ |
| 研究流程（项目/Insight/审核/报告）、只读助手 | ✅ 保留 |
| MinerU 文档解析 | ⚠️ 配置/状态/接口已定义，真实解析未启用（M3d 边界） |
| Agent 驱动的自适应抓取（recipe 自动生成） | ⚠️ 存储/审批/沙箱可用，自动提出流程未接 |
| 登录 / TLS / 存储加密 / 多用户 | ❌ 不在本仓库范围 |

## 快速开始

环境：Node ≥ 22.19（本机 22.23），Chrome（Playwright 采集回退用，可不装）。

```bash
npm ci
# .env.host（服务端密钥，已忽略提交）：
# DEEPSEEK_API_KEY=sk-...
# DEEPSEEK_MODEL=deepseek-flash   # 可选

npm run demo:api        # API: http://127.0.0.1:8788（含任务队列/调度器）
npm run dev             # 前端: http://127.0.0.1:5174
```

打开 http://127.0.0.1:5174 ：

1. **展会**（首页）→ 发现新展会 → 到 **任务** 页看进度 → 回展会页看候选、补全资料、导出。
2. **来源**：30 个中国展会/展馆/协会/媒体来源；可开关、调间隔、立即运行。
3. **项目**：原有研究流程（新建研究 → 收集/抽取 → 审核 → 报告）。
4. **Agent**：与 Pi Agent 对话（文件工具/Shell/MCP/Skills/插件），历史可回看。
5. **设置**：角色、Agent 工具开关、MCP/Skills/Plugins/Recipes、MinerU OCR。

没有 `.env.host` 时：页面可用、审核与报告可用，但研究/展会发现/Agent 会返回配置错误；
来源采集仍可用（不需要模型）。

局域网演示：`npm run demo:lan`（API+前端都绑 0.0.0.0，打印地址；无认证，只在可信网络用）。
Docker/systemd 与内网部署见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 六个页面

| 页面 | 说明 |
|---|---|
| 展会（首页） | 地区（默认中国）/时间/状态/关键词筛选；列表↔时间轴；详情含全部字段、来源与核验时间、缺失说明、文档可获取性；发现/补全/手动修正/导出 CSV·JSON |
| 任务 | 统计、状态/类型筛选、任务详情（payload/result/error/日志时间线）、取消/重试；SSE 实时 + 轮询降级 |
| 来源 | 注册表表格（URL/类型/地区/优先级/间隔/下次运行/状态）；开关、立即运行；admin 增删改、user 只能开关、viewer 只读 |
| 项目 | 研究项目列表 → 进度/证据/审核/报告；保留只读助手 |
| Agent | 项目/通用工作区对话、工具卡片、中途中止、运行历史（viewer 只读） |
| 设置 | 角色三态、Agent 工具（T0 可写）、MCP（raw JSON/连接测试）、Skills、Plugins、Recipes 审批、MinerU OCR |

中英双语即时切换；移动端 390×844 可用。

## 架构

```
React (Vite) ── Local API (Node, 单进程)
                   ├─ 任务队列 .local/tasks.json（单 worker，SSE）
                   ├─ 来源调度器 → source.collect
                   ├─ 采集器 HTTP/Readability/Playwright/recipe
                   ├─ 事件库 .local/events.json ← event.discover / event.enrich
                   ├─ 来源注册表 .local/source-registry.json
                   ├─ 研究管线（DeepSeek Search/Fetch/Extraction）+ 只读助手
                   └─ Agent 运行时（Pi SDK：文件/Shell/MCP/Skills/插件/transcripts）
```

关键文件：

```
server/local-api.mjs      HTTP/SSE 路由、角色检查、静态服务
server/task-queue.mjs     持久任务队列核心
server/task-runner.mjs    队列 + research/source/event handlers 接线
server/collector.mjs      HTTP→Readability→Playwright→recipe 采集链
server/source-registry.mjs / scheduler.mjs / rate-limit.mjs
server/event-store.mjs / event-jobs.mjs / event-search.mjs
server/recipes.mjs        recipe 存储 + vm 沙箱
server/agent-runtime.mjs  Pi Agent 会话
server/transcripts.mjs    Agent 运行历史
src/api.ts                前端唯一 API 客户端；src/types.ts 类型
src/Events.tsx / Tasks.tsx / Sources.tsx / Agent.tsx / Settings.tsx / App.tsx
seed/company-domel.json   预置公司档案（Domel/多麦机电苏州）
seed/sources-cn.json      中国来源种子（30 个）
```

## 测试与验收

```bash
npm test                        # 217 个 Node 测试
npm run build                   # tsc + vite

# 独立验收（isolated data dir，脚本头注释有完整命令）：
node scripts/acceptance-api.mjs --prepare
# 起 API 8791 + VITE_BACKEND_URL 指向它的 vite 5176，然后：
BASE=http://127.0.0.1:5176 API_BASE=http://127.0.0.1:8791 \
  ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance npm run test:ui
API_BASE=http://127.0.0.1:8791 ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance npm run test:api

# 生产模式自检：
npm run serve                   # build + 单进程 UI+API；或 docker compose up -d
```

验收结果（2026-11-03，独立验收环境）：

- 浏览器：**187 项 PASS / 0 FAIL**，0 console error / 0 pageerror；六页 + 角色三态 + 中英
  + 390×844 移动端。清单与截图：`evidence/ui-acceptance/`。
- API：**174 项 PASS / 0 FAIL**（任务/展会/来源/recipes/Agent 历史/权限矩阵/CORS/生产模式
  契约）。日志：`evidence/task-loop/API_ACCEPTANCE_2026-11-03.log`。
- 生产模式：单进程 `SERVE_STATIC=1` 下 `/`、`/assets/*`、SPA 回退、`/api/v1/workspace`
  带同源 Origin 全部 200，`evil.test` Origin 访问 API 403；见
  `evidence/task-loop/PRODUCTION_CHECK_2026-11-03.md`。
- 历史 host 路线的证据在 `evidence/runs/`，与本期本地 Demo 无关。

## 文档

1. [docs/HANDOFF.md](docs/HANDOFF.md) — 交接：状态、命令、坑、下一步
2. [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) — 已确认计划与里程碑（M1–M5）
3. [docs/TASK_QUEUE.md](docs/TASK_QUEUE.md) — 任务队列/任务 API/SSE
4. [docs/EVENT_LIBRARY.md](docs/EVENT_LIBRARY.md) — 来源注册表/采集器/展会资料库
5. [docs/AGENT_RUNTIME.md](docs/AGENT_RUNTIME.md) — MCP/Skills/Plugins/角色/会话历史
6. [docs/DOCUMENT_PARSING.md](docs/DOCUMENT_PARSING.md) — MinerU 配置与解析边界
7. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — 内网部署（systemd/Docker）
8. [docs/TEAM_CONTRACTS.md](docs/TEAM_CONTRACTS.md) — 并行开发接口契约（保留作参考）

历史文档（Supabase host 路线，本期不在范围）：`docs/HOST_API.md`、
`docs/SOURCE_COLLECTION.md`、`HOST_SETUP.md`、`WEEK6_ACCEPTANCE.md`、`supabase/`。

## 边界与限制

- 只用于**可信内网**；无认证、无 TLS；任何人可用并消耗 DeepSeek 额度。
- 同一 `.local/` 只能一个进程；JSON 存储无跨进程锁。
- 抓取只针对公开页面，遵守 robots.txt；不绕登录/付费墙/验证码。
- `system`（T0）角色只能本地 CLI 设置；Web 降级后用 `npm run agent:admin -- role admin` 恢复。
- MCP stdio server / 插件执行任意代码，仅 admin 可安装；视为主机级信任。
- 展会数据只做可核验事实与来源展示，不提供"推荐参展/不参展"判断；失败/缺失会明确标注。
- 安全、登录、加密、多用户由后续专项处理，不在本仓库继续扩展。
