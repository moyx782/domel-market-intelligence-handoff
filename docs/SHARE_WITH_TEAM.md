# 如何把当前项目分享给组员

本文件给「要接手/协作」的同学：先看第 1 节结论，再按第 2 节拿到代码，30 分钟内能跑起来。
所有命令都在仓库根目录执行（`domel-market-intelligence/`）。

## 1. 一分钟概览

- **项目**：Domel 展会资料聚合 + 市场研究工作台（单用户本地 Demo）。
- **主流程**：展会（首页，中国优先）→ 发现/补全资料 → 任务页看进度 → 导出；研究项目
  （来源→Insight→审核→报告）保留为底座能力；另有 Agent 页（Pi Agent + MCP/Skills/插件）
  和设置页（角色/工具/OCR/MCP/Skills/Plugins/Recipes）。
- **技术**：React + TypeScript + Vite 前端；Node 单进程本地 API；`.local/` JSON 存储；
  持久任务队列（单 worker，SSE）；Node 采集器（HTTP/Readability/Playwright/recipe）；
  DeepSeek 用于搜索/抽取/Agent。
- **当前状态**：M1–M5 已完成并验收；最新一轮又加了**存储式地理层级（国家/省/市/区县）**、
  **官网自动补全**、**来源/文档 URL 显示**、**境外自办展识别**。
- **质量基线**：`npm test` **234/234**；浏览器验收 **187/187**、API 验收 **175/175**、
  生产模式检查全过、0 console/page error（2026-11-03，见 `evidence/`）。

## 2. 拿到代码（四选一）

### A. GitHub 私有仓库（当前 handoff 仓库，推荐）

仓库：<https://github.com/moyx782/domel-market-intelligence-handoff>（**private**，
默认分支就是 `feature/task-loop-handoff`）。先让 Lead 把你的 GitHub 账号加为 collaborator
（Settings → Collaborators，或 `gh repo edit --add-collaborator <你的用户名>`），然后：

```bash
git clone https://github.com/moyx782/domel-market-intelligence-handoff.git
cd domel-market-intelligence-handoff
git log --oneline -8                      # HEAD 应为 7e8e297 或更新
```

### B. 内网 Git 裸仓库（团队都在内网时）

```bash
git clone <用户名>@192.168.1.10:/srv/git/domel-market-intelligence.git domel-market-intelligence
cd domel-market-intelligence
git switch feature/task-loop-handoff
```

### C. 离线 bundle（没有 Git 服务器时）

Lead 已导出：

```bash
# 文件：/home/sfwh/pi-agent-core/domel-market-intelligence-feature-task-loop.bundle
git clone /path/to/domel-market-intelligence-feature-task-loop.bundle domel-market-intelligence
cd domel-market-intelligence
git switch feature/task-loop-handoff
```

### D. 压缩包

```bash
cd /home/sfwh/pi-agent-core
tar czf domel-share.tgz \
  --exclude='domel-market-intelligence/node_modules' \
  --exclude='domel-market-intelligence/.local' \
  --exclude='domel-market-intelligence/.git' \
  --exclude='domel-market-intelligence/dist' \
  --exclude='domel-market-intelligence/.env.host' \
  domel-market-intelligence
```

**绝对不要打包/提交**：`.env.host`、`.local/`、`node_modules/`、`dist/`。`.env.host` 里有
DeepSeek key / MinerU token，单独私发。

## 3. 第一次运行（约 10 分钟）

环境：Node ≥ 22.19（本机 22.23），Chrome（Playwright 采集回退可选用）。

```bash
npm ci
cp .env.host.example .env.host      # 然后填入 DEEPSEEK_API_KEY（找 Lead 私下要）
npm run demo:api                     # API: http://127.0.0.1:8788（含任务队列/调度器）
npm run dev                          # 前端: http://127.0.0.1:5174
```

打开 http://127.0.0.1:5174 ：默认是**展会**首页（中国区、未来 12 个月、日期待确认的事件也会显示）。

没有 `.env.host` 时：页面、审核、报告、来源采集仍可用；研究/展会发现/补全会提示配置错误。

局域网演示（同一内网其他人可访问）：`npm run demo:lan`，会打印 `http://<内网IP>:5174`。
无认证，只在可信内网使用。

## 4. 阅读顺序（按重要性）

1. `docs/HANDOFF.md` — 状态、命令、坑、下一步（先读这个）
2. `docs/IMPLEMENTATION_PLAN.md` — 已确认范围与 M1–M5、第 17 节最新迭代
3. `docs/TASK_QUEUE.md` — 持久任务队列/任务 API/SSE
4. `docs/EVENT_LIBRARY.md` — 来源注册表/采集器/展会资料库/官网补全/境外自办展
5. `docs/AGENT_RUNTIME.md` — MCP/Skills/插件/角色/Agent 历史
6. `docs/DOCUMENT_PARSING.md` — MinerU 边界（解析未启用）
7. `docs/DEPLOYMENT.md` — 内网部署（systemd/Docker/LAN）
8. `docs/TEAM_CONTRACTS.md` — 并行开发接口契约（二次开发参考）
9. `README.md` — 总览 + 命令

## 5. 代码地图（先记住这些文件）

```
server/local-api.mjs      HTTP/SSE 路由、角色检查、静态服务、主进程接线
server/task-queue.mjs     持久任务队列核心（优先级/防饥饿/重试/去重/取消/重启恢复）
server/task-runner.mjs    队列 + research/source/event handlers + scheduler
server/collector.mjs      HTTP→Readability→Playwright→recipe 采集链
server/source-registry.mjs / scheduler.mjs / rate-limit.mjs
server/event-store.mjs / event-jobs.mjs / event-search.mjs
server/geo.mjs            国家/省/市/区县存储表推断（seed/geo-cn.json）
server/agent-runtime.mjs  Pi Agent 会话；transcripts.mjs 运行历史
src/api.ts                前端唯一 API 客户端；src/types.ts 类型
src/Events.tsx / Tasks.tsx / Sources.tsx / Agent.tsx / Settings.tsx / App.tsx
seed/company-domel.json   Domel 公司档案（预置，用户不填行业）
seed/sources-cn.json      30 个中国来源种子
seed/geo-cn.json          国家/省/市/区县 + 展馆地理表
```

数据都在 `.local/`（git 忽略）：`domel.json`、`tasks.json`、`events.json`、
`source-registry.json`、`documents.json`、`recipes.json`、`agent-config.json`、
`agent/mcp.json`、`agent/transcripts.json`。

重置演示：停服务 → `rm -rf .local` → 重启（会重新导入来源种子）。

## 6. 验收与回归（改动前后都跑）

```bash
npm test                 # 期望 234 passed
npm run build            # tsc + vite

# 独立验收（隔离数据，不碰仓库 .local/；脚本头注释有完整说明）
node scripts/acceptance-api.mjs --prepare           # 准备 /tmp/domel-acceptance
# 起 API 8791 + vite 5176（VITE_BACKEND_URL=http://127.0.0.1:8791）后：
BASE=http://127.0.0.1:5176 API_BASE=http://127.0.0.1:8791 \
  ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance npm run test:ui
API_BASE=http://127.0.0.1:8791 ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance npm run test:api
```

证据：`evidence/ui-acceptance/`（截图 + 清单）、`evidence/task-loop/`（PASS 日志/生产模式）。
生产模式：`npm run serve`（单进程 UI+API），或 `docker compose up -d`。

## 7. 角色与权限（功能层，不是登录）

`viewer < user < admin < system`：

- viewer：只读所有页面（含 Agent 历史）。
- user：建任务、审核、生成报告、Agent 对话、开关 MCP/Skills/插件/来源。
- admin：增删改设置/来源/recipes/插件；不能授予 system。
- system（T0）：只能本地 CLI 设置（`node scripts/agent-admin.mjs role system`），
  控制文件工具/Shell；Web 降级后 `npm run agent:admin -- role admin` 恢复。

## 8. 已知边界（分享时要讲清楚）

- 只在**可信内网**用；无认证、无 TLS；同一 `.local/` 只能一个进程。
- 安全/登录/加密/多用户不在本仓库范围，由专项处理。
- MinerU 真实解析未启用（`/events/:id/parse` 对已配置文档返回 501，只登记链接与可获取性）。
- Agent 自动生成 recipe 的闭环、Agent 驱动研究、PDF 简报未完成；任务队列仍是单进程 JSON。
- 抓取遵守 robots.txt/站点条款，不绕登录/付费墙/验证码。
- 展会资料只列事实与来源，不做"推荐参展/不参展"判断；缺失/冲突会写进 notes。

## 9. 当前待办 / 下一步（按优先级）

1. **筛选与偏好（用户最新提出，未实现）**：展会页支持正向/反向筛选（包含/排除关键词、
   地区、行业等），可设置"倾向"（偏好地区/行业/城市/规模等）并参与排序或高亮，
   提高自定义程度（保存筛选方案/视图预设）。需要 API + 前端 + 测试。
2. MinerU 真实解析：任务化 `document.parse`，只对 downloadable + 管理员启用的文档。
3. Agent 自适应抓取闭环：失败页快照 → Agent 生成 recipe → 设置页审批 → 确定性复用。
4. Agent 驱动研究（替换固定管线）。
5. 展会数据质量：更多日历页/RSS/sitemap 解析器；日期冲突处理；核验工作流。
6. PDF 简报导出。
7. 任务队列换 Postgres/分布式、认证/多用户（专项）。

## 10. 建议分工（5 人）

| 角色 | 负责 |
|---|---|
| 前端 A | 展会页筛选/偏好/视图自定义（新需求） |
| 前端 B | 任务/来源/Agent/设置页维护 + i18n/移动端 |
| 后端 A | 任务队列、任务 API/SSE、研究接线、队列扩展（Postgres 接口） |
| 后端 B | 采集器/来源注册表/recipe/展会 discover/enrich/地理表/官网补全 |
| QA/部署 | 验收脚本、证据、生产模式、Docker/systemd、演示环境 |

接口先改契约（`docs/TEAM_CONTRACTS.md` 风格），文件写作用域分开，Lead 统一集成/提交。

## 11. 可直接发给组员的消息（复制即用）

> 大家好，Domel 展会资料 Demo 的 M1–M5 已完成并验收（任务队列/任务页、Node 采集器、
> 来源注册表、中国展会资料库、来源页、Agent 页、设置页 MCP/Skills/Plugins/Recipes，
> 四级角色）。代码在 GitHub 私有仓库
> https://github.com/moyx782/domel-market-intelligence-handoff （分支
> `feature/task-loop-handoff`，需要我加你为 collaborator），Node ≥22.19：
> `npm ci` → 私发要 `.env.host`（DeepSeek key）→ `npm run demo:api` + `npm run dev`，
> 打开 5174。先读 `docs/HANDOFF.md`，再读 `docs/IMPLEMENTATION_PLAN.md` 和
> `docs/EVENT_LIBRARY.md`。基线：`npm test` 234/234、`npm run build` 通过、当前演示在
> http://192.168.1.10:5174（内网）。最新迭代已加：展会国家/省/市/区县（存储表推断，
> 不是正则猜）、官网自动补全（搜索候选→抓取核验→优先首页）、来源/文档 URL 直接可见、
> 境外自办展识别（中国（阿联酋）这类按括号国家归境外）。注意：`.env.host`、`.local/`
> 不提交；只在可信内网用；一个 `.local/` 只跑一个进程。下一步优先做展会页正向/反向筛选
> + 倾向设置 + 自定义视图。有问题在群里 @ 我。

## 12. 关键文件与证据索引

| 内容 | 位置 |
|---|---|
| 交接/坑/命令 | `docs/HANDOFF.md` |
| 计划与里程碑 | `docs/IMPLEMENTATION_PLAN.md` |
| 任务队列 | `docs/TASK_QUEUE.md` |
| 展会/来源/地理 | `docs/EVENT_LIBRARY.md` |
| Agent/MCP/Skills | `docs/AGENT_RUNTIME.md` |
| OCR/MinerU | `docs/DOCUMENT_PARSING.md` |
| 部署 | `docs/DEPLOYMENT.md` |
| 接口契约（并行开发） | `docs/TEAM_CONTRACTS.md` |
| 浏览器验收截图/清单 | `evidence/ui-acceptance/` |
| 验收日志/生产模式 | `evidence/task-loop/` |
| 离线代码包 | 由 Lead 执行 `git bundle create` 生成（见第 2 节） |
