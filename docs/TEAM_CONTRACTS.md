# 团队并行开发契约（M1–M5）

本文档是 Lead 与各并行成员之间的接口契约。**开工前必须完整读一遍**，然后读
`docs/HANDOFF.md`、`docs/IMPLEMENTATION_PLAN.md` 第 4/6/7/8/9/10/11/12 节。

- 仓库：`/home/sfwh/pi-agent-core/domel-market-intelligence`（工作目录即为仓库根）。
- 分支：`feature/task-loop-handoff`，基线已提交（commit `ce76f94`）。
- 基线：`npm test` 72/72 通过，`npm run build` 通过。任何成员都不得把基线弄坏。
- 目标：按 `IMPLEMENTATION_PLAN.md` 完成 M1–M5；用户要求"不要吝惜 token、做完整"。

## 0. 通用规则（违反会阻塞集成）

1. **只写自己 task 里列出的文件。** 清单见第 2 节。需要改别人文件时，发消息给 Lead，不要直接改。
2. **不要 git commit / git add / git checkout / 改分支。** Lead 统一提交。
3. **不要新增 npm 依赖**（无 `cheerio`/`jsdom`/`readability`）。用 Node 内置能力自己实现；Playwright 已有 `playwright-core` 和系统 Chrome（`/usr/bin/google-chrome`）。
4. **不要用真实网络写单测**。单元测试用注入的 `fetchImpl`、fixtures、临时目录（`mkdtempSync`）。真实抓取只在 M3c 验收/Lead 验收时做。
5. **不要写仓库内 `.local/`、`dist/`、`.env*`**。测试/本地实例一律用 `mkdtempSync(join(tmpdir(),'domel-...'))`。
6. **代码风格**：ESM `.mjs`（server/tests/scripts）或 TSX（src）；沿用现有缩进（1 个空格）与命名；注释写"为什么"而不是"是什么"；中文注释可接受但代码标识符用英文。
7. **测试用 `node:test` + `node:assert/strict`**。文件命名 `tests/<module>.test.mjs`。单文件跑：`node --test tests/task-queue.test.mjs`。全量：`npm test`。
8. **失败要显式**：对外 HTTP 错误返回 `{error: string, requiredRole?}`，角色不足 403；校验失败 400；不存在 404；状态冲突 409。内部模块 throw `Error`（永久错误给 `error.permanent = true`）。
9. **写盘必须原子**：`writeFileSync(tmp)` + `renameSync(tmp, file)`；JSON 缩进 2；目录 `mkdirSync(...,{recursive:true})`。
10. **不要在日志/响应里输出密钥**。OCR token 只返回 `tokenSet`。
11. **完成时给 Lead 发消息**：改了哪些文件、测试命令与结果、跑过什么真实抓取、未决问题。不要只写"done"。
12. DNS/安全边界：抓取只针对公开 http(s) 页面，遵守 robots.txt；不绕登录/付费墙/验证码；recipe 沙箱无网络。

## 1. 里程碑与任务编号

| 任务 | 内容 | 负责人 |
|---|---|---|
| M1 | 持久任务队列核心 + 单测 | b1-queue |
| M3a | Node 采集器（HTTP/Readability/Playwright）+ 限流器 + recipe 沙箱 | b2-collector |
| M3b/d | 来源注册表 + scheduler + documents + 事件存储 + event.discover/enrich + 种子来源 | b3-events |
| M2 | 任务页 + 来源注册表页 | f1-pages |
| M3c/M4/M5 | 展会页 + Agent 页 + 设置页扩展 | f2-pages |
| — | local-api 接线、任务 API/SSE、research 接入、App 接线、集成测试 | Lead |
| QA | 浏览器验收、生产模式、证据、全量回归 | qa-verify（后置） |

## 2. 文件所有权（写作用域）

**Lead 独占（成员不要动）**

```
server/local-api.mjs  server/permissions.mjs  server/research-runner.mjs  server/task-runner.mjs
src/App.tsx  src/types.ts  src/api.ts  src/i18n.tsx  src/main.tsx  src/data.ts
docs/*  README.md  package.json  .env*.example  Dockerfile  docker-compose.yml  deploy/
scripts/ui-acceptance.mjs（QA 接手后由 qa-verify 独占）
tests/task-api.test.mjs tests/events-api.test.mjs tests/sources-api.test.mjs tests/recipes-api.test.mjs tests/permissions.test.mjs
tests/agent-sessions.test.mjs
```

**b1-queue**

```
server/task-queue.mjs            （重写，必要时保留旧导出兼容）
tests/task-queue.test.mjs
```

**b2-collector**

```
server/collector.mjs
server/rate-limit.mjs
server/recipes.mjs
tests/collector.test.mjs  tests/rate-limit.test.mjs  tests/recipes.test.mjs
tests/fixtures/collector/*（HTML/robots 快照、假页面服务）
```

**b3-events**

```
server/source-registry.mjs  server/scheduler.mjs  server/documents.mjs
server/event-store.mjs     server/event-jobs.mjs
seed/sources-cn.json
tests/source-registry.test.mjs  tests/scheduler.test.mjs  tests/documents.test.mjs
tests/event-store.test.mjs  tests/event-jobs.test.mjs
tests/fixtures/events/*（HTML/JSON-LD 快照、假搜索响应）
```

**f1-pages**

```
src/Tasks.tsx  src/Sources.tsx  src/messages-tasks.ts  src/tasks-sources.css
```

**f2-pages**

```
src/Events.tsx  src/Agent.tsx  src/Settings.tsx  src/messages-events.ts  src/events-agent.css
```

**qa-verify**

```
scripts/ui-acceptance.mjs   evidence/ui-acceptance/*   evidence/task-loop/*
scripts/acceptance-api.mjs（新建则归 QA）
```

任何人新建测试文件必须用自己的清单内命名；fixtures 目录按上面归属，不要交叉。

## 3. M1 任务队列契约（b1-queue）

`server/task-queue.mjs` 导出：

```js
export const TASK_KINDS = ['event.discover','event.enrich','source.collect','project.research','project.extract'];
export function openTaskQueue({file, concurrency = 1, handlers = {}, retryDelaysMs = [5000, 30000, 120000], starvationMs = 300000, now = () => Date.now()})
```

返回值（全部同步返回普通对象，写操作返回 Promise）：

- `start()` / `stop()`：启动/停止调度循环与所有 AbortController；`stop()` 不清空持久化状态。
- `create({kind, priority = 1, projectId = null, eventId = null, sourceId = null, payload = {}, maxAttempts = 3})` → `Promise<Task>`。
  - **去重**：存在同 `kind + projectId + eventId + sourceId` 的 queued/running 任务时直接返回旧任务（不新建、不重置）。
  - priority 0–3，**3 最高**（P0）。`maxAttempts` 是最大启动次数（默认 3）。
- `list({state, kind, projectId, eventId, sourceId, limit = 200} = {})` → `Task[]`（createdAt 倒序）。
- `get(id)` → `Task | null`。
- `stats()` → `{queued,running,succeeded,failed,cancelled}`（其余状态也计数）。
- `cancel(id)` → `Promise<Task>`：queued 立即变 cancelled；running 置 `cancelRequested=true` 并 abort；找不到 throw `Task not found`。
- `retry(id)` → `Promise<Task>`：仅 failed/cancelled；重置 attempts=0/error=null/notBefore=0 转 queued；running throw `Task is running`。
- `subscribe(listener)` → unsubscribe。订阅时立即回调一次 `{type:'snapshot', tasks, stats}`；之后每次状态/日志变化回调 `{type:'task', task}`（前端按 id 覆盖即可）。
- `idle({timeoutMs = 10000} = {})` → `Promise<void>`：没有 queued/running 时 resolve，否则轮询；测试/关机用。

调度语义：

- 有效优先级 `effectivePriority = min(3, priority + floor((now - max(createdAt, 0)) / starvationMs))`；按 effectivePriority 降序、createdAt 升序、id 字典序取下一个；`notBefore > now` 的任务不可取。
- 状态机：`queued → running → succeeded|failed|cancelled`；`running` 被 cancel 时若 handler 不抛错也最终记 cancelled；失败且 `attempts < maxAttempts` → queued + `notBefore = now + retryDelaysMs[attempts-1]`；否则 failed。
- 永久错误：handler throw 的 error 上 `error.permanent === true` → 直接 failed，不重试。
- 无 handler 的 kind：永久失败，错误信息 `No handler for <kind>`。
- `running` 任务在进程重启后 → `queued`（`log` 里记 warn：`Recovered after restart`），attempts 保留。
- 每次状态/日志变化都持久化（原子写）；`log` 最多保留 60 条 `{at: ISO字符串, message, level:'info'|'warn'|'error'}`。
- 持久化结构：`{version:1, tasks:[...]}`。`Task` 字段：`id,kind,state,priority,effectivePriority,attempts,maxAttempts,notBefore,projectId,eventId,sourceId,payload,progress,result,error,log,createdAt,updatedAt,startedAt?,finishedAt?`。
- handler 调用形态：`await handlers[kind]({task, signal, update(changes), log(message, level)})`。`update` 支持 `{progress?, result?, log?, level?}`，内部必须过串行化写队列。

单测必须覆盖（M1 验收）：优先级顺序、防饥饿提升、重试 5s/30s/2min 的调度（可注入短 `retryDelaysMs` 与假 now）、去重、取消（排队+运行中）、retry、重启恢复、永久错误、订阅事件、原子持久化。总测试时长 < 5s（用短延迟）。

## 4. 任务 API（Lead 实现，供前端使用）

```
GET  /api/v1/tasks?state=&kind=&projectId=&eventId=&sourceId=&limit=
     → {tasks: Task[], stats: TaskStats}        所有角色可读
GET  /api/v1/tasks/:id        → Task | 404
POST /api/v1/tasks/:id/cancel → Task（user+，权限名 tasks:write）
POST /api/v1/tasks/:id/retry  → Task（user+）
GET  /api/v1/tasks/stream     → SSE：{type:'snapshot',tasks,stats} / {type:'task',task}，
                                15s keep-alive 注释行；所有角色可读
```

创建类接口统一返回 `{task}`：

```
POST /api/v1/events/discover        body {region?, query?, limit?}   user+ → {task}
POST /api/v1/events/:id/enrich                                       user+ → {task}
POST /api/v1/sources/:id/run                                         user+ → {task}
```

## 5. 采集器 / 限流 / recipe 契约（b2-collector）

### 5.1 `server/collector.mjs`

```js
export function extractReadable(html, {url} = {}) // → {title, text, html?} 正文抽取；导出供测试
export function extractJsonLd(html)               // → object[]（<script type="application/ld+json">）
export function createCollector({fetchImpl = globalThis.fetch, launchBrowser, timeoutMs = 20000, maxBytes = 2_000_000, userAgent = 'DomelMarketIntelligence/0.1 (+intranet demo)', limiter, now = () => Date.now()})
```

`collector.collect(url, {signal, allowPlaywright = true, recipe} = {})` → Promise：

```js
{ok, url, finalUrl, status, engine: 'http'|'browser'|'recipe', title, text, html,
 contentType, bytes, fetchedAt, robots: {allowed, crawlDelayMs}, error?:
 {code, message, retryAfterMs?, permanent?}}
```

行为：

1. 仅 http(s)；先取 `origin/robots.txt`（内存缓存 1h，按 `User-agent: *` 解析 Allow/Disallow/Crawl-delay），不允许 → 返回 `ok:false, error:{code:'ROBOTS_DENIED', permanent:true}`。
2. 有 `limiter` 时：`await limiter.acquire(url, {crawlDelayMs})`。
3. HTTP fetch：20s 超时、流式累计 > maxBytes 中断（`TOO_LARGE`, permanent）、content-type 必须是 text/html 或 application/xhtml+xml（否则 `BAD_CONTENT_TYPE`, permanent）；手动跟随重定向（最多 5 次，相对地址解析）。
4. `extractReadable`；正文 < 300 字且 `allowPlaywright` 时回退 Playwright（`launchBrowser` 可注入；默认动态 import `playwright-core` + `CHROME_PATH || /usr/bin/google-chrome`，headless，`--no-sandbox --disable-dev-shm-usage`，复用实例、`close()` 释放；失败不 fatal，保留 http 结果并标注）。
5. 仍不足且传入 `recipe` → `applyRecipe(recipe, {html, url, text})`，engine='recipe'。
6. 错误映射：403 → `BLOCKED`（permanent，同时 `limiter.blockDomain(domain)`）；429/503 → `RATE_LIMITED` + `retryAfterMs`（解析 `Retry-After` 秒/日期）；超时 `TIMEOUT`；网络错误 `NETWORK`；5xx 可重试。永久错误设 `error.permanent=true`。
7. `probe(url, {signal})` → `{ok,status,contentType,contentLength,availability:'downloadable'|'restricted'|'unknown'}`：HEAD，失败降级 GET `Range: bytes=0-0`；403/401 → restricted。供 M3d 文档可获取性使用。

单测（用注入 `fetchImpl` + fixtures，不联网）覆盖：正常 HTML 抽取、JS 壳 Playwright 回退（本地 http server 起一个需 JS 渲染的页面；Chrome 不存在时 skip）、超时、超大页、content-type 拒绝、403/429、robots 拒绝、重定向、去重（同一 URL 不重复抓）。

### 5.2 `server/rate-limit.mjs`

```js
export function createRateLimiter({now = () => Date.now(), defaultIntervalMs = 5000, defaultCrawlDelayMs = 0})
```

返回：

- `acquire(url, {crawlDelayMs = 0, minIntervalMs = 0} = {})` → Promise：每域令牌桶容量 1；实际间隔 = `max(配置, crawlDelay, 最小值)` + 0–5s jitter（jitter 可通过选项关闭，测试稳定）；域被 block 时 reject `Error`（`code='DOMAIN_BLOCKED'`, permanent）。
- `setIntervalMs(domain, ms)` / `intervalMs(domain)`；`blockDomain(domain, {reason})` / `isBlocked(domain)`；`backoff(domain, retryAfterMs)`（429 后推迟下次请求）；`state()` 返回可观测快照；`reset()` 测试用。
- 单测：同域串行间隔、不同域并行、crawl-delay 取大、backoff、block、30s 最小间隔由调用方传入时生效。

### 5.3 `server/recipes.mjs`

```js
export function openRecipeStore({file})   // .local/recipes.json，{version:1, recipes:[]}
```

方法：`list({domain, status} = {})`、`get(id)`、`propose({domain, kind, body, proposedBy='agent', notes=''})`（同 domain+kind 内容 hash 相同则复用，version 递增）、`update(id, {body?, status?, notes?})`（status ∈ proposed/approved/disabled）、`remove(id)`。

```js
export function applyRecipe(recipe, {html, url, text}) // → {ok, values, error?}
```

- `kind:'script'`：`node:vm` 沙箱执行 `body`（字符串函数体或 `module.exports` 风格均可，统一 `body` 为函数源码字符串，如 `(input) => ({startDate: ...})`），沙箱 context 只有 `input={html,url,text,jsonLd}`、`console`（静默）；**无 require/process/fetch/globalThis 逃逸**；超时 1000ms；返回对象即 values。超时/异常 → `{ok:false,error}`。
- `kind:'regex'`：`body` 为 `{field: {pattern, group?}}` 的 JSON 字符串或对象；对 text 跑正则返回 values。
- `kind:'selectors'`：`body` 为 `{field: 'selector'}`；支持极简 CSS：`tag`、`.class`、`#id`、`[attr]`、`[attr=value]`、空格后代；用最小 HTML tokenizer 实现，返回每个字段第一个匹配的 textContent（`@attr` 语法取属性，如 `'a.event[href]@href'`）。无法解析 → `{ok:false,error}`。
- 单测：三种 kind 各一个、沙箱无法访问 process/fetch、超时、store CRUD/version、proposed→approved 状态流转。

## 6. 来源 / 文档 / 事件（b3-events）

### 6.1 `server/source-registry.mjs`

```js
export function openSourceRegistry({file, seedFile})
```

JSON 结构 `{version:1, sources:[], domains:{}}`；首次打开且 sources 为空时从 `seedFile` 导入（`seed/sources-cn.json` 为 `{sources:[...]}`）。

Source 字段（`SourceEntry`）：`id,url,domain,title,type('venue'|'association'|'organizer'|'media'|'site'|'rss'|'sitemap'),region('cn'|'eu'|'global'),enabled(true),priority(1),intervalSec(≥30，默认 3600),lastRunAt,nextRunAt,status('idle'|'running'|'error'|'paused'|'manual'),lastError,discoveredBy('human'|'agent'),createdAt,updatedAt`。

方法：`list({region, enabled, type} = {})`、`get(id)`、`create({url,title,type,region,priority,intervalSec})`（URL 唯一、去 fragment、校验 http(s)、domain 提取、interval ≥30）、`update(id, patch)`（含 enabled/priority/intervalSec/url/title/type/region/status）、`remove(id)`、`due(nowMs)`（enabled && status!=='paused' && (nextRunAt??0) <= nowMs）、`markRunning(id)`、`markResult(id, {ok, error, nowMs, crawlDelayMs})`（ok → lastRunAt/nextRunAt=now+interval、status idle；error → status error、lastError；BLOCKED → status paused）、`stats()`。所有写操作原子持久化。

### 6.2 `server/documents.mjs`

`openDocumentStore({file})` → `.local/documents.json` `{version:1, documents:[]}`。
`save({sourceId,url,title,text,htmlBytes,engine,fetchedAt,hash?})`：URL 去重（同 url 更新而不是新增，保留 `firstFetchedAt`、`fetchedAt`、`runs` 计数）；`list({sourceId, since} = {})`；`get(id)`；`stats()`；`hash(text)`（sha256 前 16 位）导出。M3d 文档可获取性：`documents` 里只存页面；文档链接由 event-jobs 用 collector.probe 分类。

### 6.3 `server/event-store.mjs`

`openEventStore({file})` → `.local/events.json` `{version:1, events:[]}`。Event 字段见 `src/types.ts` 的 `MarketEvent`（Lead 已写）与计划第 6 节。

方法：

- `list({from,to,region,status,q,limit=500} = {})`：from/to 按 startDate 过滤（无日期的事件只在无 from/to 时返回），q 匹配 name/city/venue/industries 子串（大小写不敏感）。
- `get(id)`、`stats()`。
- `upsert(candidate)` → `{event, created}`：去重键 = 规范化名称 +（startDate 或 ''）+（venue 或 ''）；已存在时合并：非空新值覆盖、`sources` 按 url 去重合并、`documents` 按 url 去重、`notes` 去重合并、`confidence` 取高、`updatedAt` 刷新；不存在则创建完整默认结构（空字符串/空数组/null，status='discovered'）。
- `patch(id, changes)`：只允许已知字段；字段校验（日期 `YYYY-MM-DD` 或 null、status/confidence/region 枚举、数组/字符串类型）；`sources` 变更追加 `{url,title,verifiedAt:now}`；返回更新后的 Event；未知字段 400 由 API 层处理。
- `exportRows()`：扁平行数组（CSV 用，列固定顺序：name,edition,startDate,endDate,city,country,venue,organizer,website,frequency,industries,scope,exhibitorCount,visitorCount,area,exhibitorListUrl,exhibitorListStatus,applicationDeadline,boothPrice,ticketPrice,region,confidence,status,sources,notes）。
- 所有写操作原子持久化。

### 6.4 `server/event-jobs.mjs`

```js
export function createEventJobs({eventStore, registry, collector, search, region = 'cn', now = () => Date.now(), onTaskProgress})
```

返回任务 handler 映射，供 Lead 的 task-runner 直接注册：

```js
{'event.discover': async ctx => {...}, 'event.enrich': async ctx => {...}}
```

handler 的 `ctx = {task, signal, update, log}`（与 M1 契约一致）。返回的结果写进 `task.result`。

- `event.discover`：payload `{region?, query?, limit? = 30}`。
  1. 用 `search({query, region, limit})`（注入；默认实现在 Lead 的 task-runner 里用 DeepSeek 或 registry 页面兜底）拿候选：`[{name, city?, venue?, startDate?, endDate?, website?, sourceUrl?, industries?, confidence?}]`。
  2. 逐个 `eventStore.upsert` 规范化；记录 created/merged 数。
  3. `update({progress})` 分阶段；返回 `{region, candidates, created, merged, queries}`。
  4. 搜索失败要区分：`search` throw 可重试错误 → 任务重试；无结果不算失败，返回 `created:0` 并 log warn。
- `event.enrich`：payload `{eventId}`。
  1. 读 event；候选 URL = event.website + event.sources[].url；逐个 `collector.collect(url, {signal, recipe: approvedRecipeForDomain})`（recipe 可选注入 `getRecipe(domain)`，默认无）。
  2. 用 JSON-LD（`Event` 类型）优先，然后正则/标题启发式补：name/startDate/endDate/city/venue/organizer/website/industries/applicationDeadline/boothPrice。
  3. 发现 documents 链接（pdf/xlsx/doc 等）→ `collector.probe` 分类 availability，写 `documents[]`；`exhibitorListStatus` 同理。
  4. 只填"有来源"的字段；缺失写 `notes`（如 `未找到报名截止日期`、`展馆待确认`），置信度 medium/low；状态 enriched/verified。
  5. 返回 `{eventId, collected: n, fields: [...], notes}`，并 `eventStore.patch`。
- 测试：注入 fake `search`/`collector`（对象实现 collect/probe），fixtures 覆盖 JSON-LD 完整事件、缺日期、文档链接分类、upsert 去重合并。**不联网。**

### 6.5 `server/scheduler.mjs`

```js
export function createScheduler({registry, queue, intervalMs = 30_000, now = () => Date.now(), onError})
```

- `start()` 定时器（unref；立即 tick 一次）；`stop()`；`tick()` 可测试导出。
- tick：`registry.due(now())` → 对每个 source `queue.create({kind:'source.collect', sourceId: id, priority: source.priority, payload:{sourceId: id, url: source.url}})`（M1 去重天然防重复）；`registry.markRunning` 由 task handler 做，不在 tick 里改状态，避免任务失败后 source 永远 running。记录日志。
- 单测：fake queue 记录 create 调用、只调度 due/enabled、去重由 queue 负责不再重复调 create 的验证（fake 返回已有任务也能接受），坏 source 不阻塞其他 source。

### 6.6 `seed/sources-cn.json`

≥20 个中国区来源，覆盖计划第 9 节：`m.domain` 用真实候选域名（展馆、协会、展会官网、媒体、Domel 官网 blog/sitemap、展会相关站点）。类型/region/priority/intervalSec 合理（intervalSec ≥ 30，多数 3600–86400）。字段名与 Source 的创建输入一致（`url,title,type,region,priority,intervalSec`）。来源不必全部可访问（抓不到会标 error/manual），但 URL 必须是 https 且格式合法；测试只校验结构与数量，不联网。

## 7. 前端契约（f1-pages / f2-pages）

Lead 已写好 `src/types.ts`（类型）与 `src/api.ts`（所有 API 调用函数）。**只能通过 `src/api.ts` 访问后端，不要自己 fetch（Settings.tsx 已有的 request 可保留）**。类型/函数不满足需求时发消息给 Lead，不要改这两个文件。

### 7.1 页面组件 props

```tsx
// Tasks.tsx
export default function Tasks({role}:{role:Role}) {}
// Sources.tsx
export default function Sources({role}:{role:Role}) {}
// Events.tsx
export default function Events({role}:{role:Role; onOpenTasks:()=>void; onOpenEvent?:(id:string)=>void}) {}
// Agent.tsx
export default function Agent({role,projects}:{role:Role; projects:Project[]}) {}
```

页面内部用 `useI18n()` 拿 `t`；中文词条放各自 `src/messages-*.ts`，模块顶层调用：

```ts
import {registerMessages} from './i18n';
registerMessages({ /* 'English key':'中文' */ });
```

（`registerMessages` 由 Lead 在 i18n.tsx 增加；App 静态 import 页面模块，注册先于渲染。）
**所有界面文案必须先写英文 key 再补中文**，否则中文模式漏英文（已知坑 5）。数字/时间用 `Intl.DateTimeFormat`/`toLocaleDateString('zh-CN'|'en-GB')` 随语言。

### 7.2 页面要求（验收口径）

**Tasks（f1）**：顶部统计（queued/running/succeeded/failed/cancelled）；筛选 state/kind；列表列：kind、状态徽章、进度、关联对象、attempts、创建时间、耗时；点开详情显示 payload、result、error、日志时间线（级别颜色）；操作：取消（queued/running）、重试（failed/cancelled），按 `role` 三态（viewer 只读、user 可操作、admin/system 同）。SSE 实时更新（`streamTasks`），断线自动重连（EventSource 自带）+ 进入页面先拉一次；SSE 不可用时降级 3s 轮询。空态/加载/错误态齐全。

**Sources（f1）**：注册表表格：标题/URL、类型、地区、优先级、间隔、下次运行、状态、开关、立即运行；筛选 region/type/enabled；admin+ 可新增/编辑/删除，user 只能开关，viewer 只读（`role` 判断，API 403 也要处理）；新增表单校验 URL/interval≥30；"立即运行"创建任务后 toast 并可跳转任务页（可通过 props 不提供，toast 提示即可）；展示 scheduler/来源统计。

**Events（f2，作为首页）**：筛选 region（默认 cn）/时间范围（未来 6/12 个月/全部）/状态/关键词；列表与时间轴切换；卡片显示日期、名称、城市、展馆、资料完整度（有来源字段比例）、竞品参展数、状态/置信度徽章；详情（同页侧栏或弹层）显示全部字段、官方链接、来源与核验时间、缺失说明（notes）、documents 链接与 availability；操作：发现新展会（user+，创建任务并提示去任务页）、补全资料（user+）、手动修正（user+ 表单，PATCH）、导出 CSV/JSON（`exportEvents` 下载）；viewer 只读隐藏操作。空态引导"发现新展会"。

**Agent（f2，M5）**：项目选择（general + 项目列表）；对话流（用户/助手气泡、工具卡片 tool_start/tool_end、warning/done/error）；输入框 + 发送（role=viewer 时隐藏输入、显示只读历史入口）；SSE 流式（`streamAgentChat`），可中断（abort）；历史会话列表（`getAgentSessions`）与只读 transcript 详情（viewer 必须能看）；清空/新会话按钮可选（不必强制）。

**Settings（f2，M4）**：保留现有角色/Agent tools/OCR 三块不动或仅微调；新增：
- MCP servers 列表（名称、transport、enabled 开关、raw JSON 编辑/整体替换、连接测试按钮显示工具列表）；admin 可编辑，user 只能开关，viewer 只读。
- Skills 列表（名称/描述/启用开关/内容编辑/删除/新增）；同上三态。
- Plugins 列表（名称/slug/启用开关/新增/删除）；同上三态。
- Recipes 列表（domain/kind/version/status；approve/disable；admin+）。
所有 API 用 `src/api.ts`；403 时显示后端错误。

样式：f1 只改 `src/tasks-sources.css`，f2 只改 `src/events-agent.css`；复用现有 `.panel/.page-heading/.badge/.table-wrap/.review-actions` 等类。Lead 在 `main.tsx` 统一 import 两个 css。响应式：≤900px 表格横向滚动/卡片堆叠；390×844 移动端可用（验收会跑）。

### 7.3 `src/api.ts` 已提供的函数（以文件为准）

```
getCapabilities()
getTasks(params) getTask(id) cancelTask(id) retryTask(id) streamTasks(onEvent)
listEvents(params) getEvent(id) discoverEvents(body) enrichEvent(id) patchEvent(id,changes) exportEvents(format)
listSources(params) createSource(body) updateSource(id,patch) deleteSource(id) runSource(id)
listRecipes(params) createRecipe(body) updateRecipe(id,patch) deleteRecipe(id) testRecipe(id,url)
getAgentConfig() addMcp(body) updateMcp(name,patch) deleteMcp(name) testMcp(name)
addSkill(body) updateSkill(id,patch) deleteSkill(id)
addPlugin(body) updatePlugin(id,patch) deletePlugin(id)
getAgentSessions(projectId) getAgentTranscript(id) streamAgentChat({projectId,message,onEvent,signal}) → {abort}
```

## 8. Lead 侧集成（不用成员实现，但要知道接口）

- `server/task-runner.mjs`：`createTaskRunner({store, env, queueFile, eventStore, registry, collector, eventJobs, researchRunner, concurrency})` → `{queue, start, stop}`；注册 `project.research`/`project.extract`（调用 `research-runner` + store job 生命周期）、`source.collect`（registry+collector+documents+limiter）、`event.discover`/`event.enrich`（eventJobs）。
- `server/research-runner.mjs`：把 local-api 里现有 `configureResearch` 抽出为可复用函数，保持行为不变（现有 72 个测试不动）。
- `local-api.mjs`：新增选项 `queue,eventStore,registry,recipes,documents,transcripts`；无 `queue` 时研究路由保留原有数组队列（兼容现有测试）。新增路由见第 4 节与计划第 10 节；角色检查用 `can(role, action)`，403 返回 `{error, requiredRole}`。
- 权限新增（Lead 实现）：`tasks:write`(user)、`events:write`(user)、`sources:toggle`(user)、`sources:manage`(admin)、`recipes:manage`(admin)。
- Agent 会话记录：Lead 在 `agent-runtime.mjs` 里追加 transcript 持久化（`.local/agent/transcripts/<project>.json`），提供 `GET /api/v1/agent/sessions` 与 `/sessions/:id`（所有角色可读；viewer 只读）。

## 9. 测试与完成标准

- 每个任务：新增测试全绿 + `npm test` 全绿（当前 72 + 新增）+ `npm run build` 通过。
- b1/b2/b3 交付前自测：
  ```bash
  node --test tests/task-queue.test.mjs          # b1
  node --test tests/collector.test.mjs tests/rate-limit.test.mjs tests/recipes.test.mjs   # b2
  node --test tests/source-registry.test.mjs tests/scheduler.test.mjs tests/documents.test.mjs tests/event-store.test.mjs tests/event-jobs.test.mjs   # b3
  npm test
  ```
- f1/f2：`npm run build` 必须通过（tsc + vite）。页面没法单独跑就依赖 Lead 接线后的浏览器验收；组件逻辑简单可加 `src/*.test` 不做，浏览器验收覆盖。
- 真实抓取留给 M3c/Lead 验收；需要网络时用 `curl -I` 先验证，不要在单测里依赖外网。
- **禁止**：跑 `npm run serve`/`demo:api` 占用 8788/5174 端口超过必要时间；如果要用，结束后 kill。多个成员同时起服务会端口冲突，先问 Lead。

## 10. 沟通

- 开工：`team_task_list` 找到自己的任务 → `team_task_get` → `team_task_update action=claim expected_revision=...`。
- 完成：`team_task_update action=complete`，然后 `send_message target=lead` 发交付摘要（文件、测试、未决、需要 Lead 接线/修改的点）。
- 中途遇到接口歧义/需要改 Lead 文件：立刻发消息，不要自行改。
- 预计顺序：b1/b2/b3 先各自完成模块；Lead 在 b1 完成后先接 queue 进 local-api，再接 b2/b3；f1/f2 与后端并行写 UI，靠 `src/api.ts` 契约编译。
