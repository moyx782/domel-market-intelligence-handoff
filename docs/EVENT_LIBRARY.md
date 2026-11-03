# 展会资料库、来源注册表与采集器（M3）

本文件说明从"来源 URL"到"可核验展会资料"的完整链路。产品规则见
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) 第 6、8、9 节；实现分布：

| 模块 | 职责 |
|---|---|
| `server/source-registry.mjs` | 来源注册表（URL/类型/地区/优先级/间隔/调度状态） |
| `server/scheduler.mjs` | 到期来源 → `source.collect` 任务（不自己改来源状态） |
| `server/collector.mjs` | HTTP → Readability → Playwright → recipe 采集链 + robots + 文档可获取性 probe |
| `server/rate-limit.mjs` | 每域令牌桶、Crawl-delay、429 退避、403 暂停 |
| `server/recipes.mjs` | Agent/人工提出的选择器/正则/脚本 recipe 存储与沙箱执行 |
| `server/documents.mjs` | 采集到的页面（按 URL 去重） |
| `server/event-store.mjs` | 展会资料库（去重合并、过滤、CSV 导出） |
| `server/event-jobs.mjs` | `event.discover` / `event.enrich` handler（官网查找、首页优先、地理推断） |
| `server/event-search.mjs` | 发现来源：DeepSeek JSON 候选 + 无模型时注册表页面扫描兜底；官网候选排序 |
| `server/geo.mjs` + `seed/geo-cn.json` | 国家/省/市/区县/展馆存储表推断（不用名称正则） |
| `src/Events.tsx` | 展会首页（筛选/时间轴/详情/补全/修正/导出） |
| `src/Sources.tsx` | 来源注册表页 |

## 1. 数据流

```
来源注册表（seed/sources-cn.json 30 个中国来源）
  → scheduler.tick（每 30s，只取 enabled && nextRunAt <= now && status != paused）
  → 任务队列 source.collect（同 kind+sourceId 去重）
  → collector.collect：robots → 每域限流 → HTTP(20s/2MB) → Readability
       → 正文不足时 Playwright（系统 Chrome） → 仍不足且已有 approved recipe 时 recipe
  → documents.save（按 URL 去重，保留 runs 次数）
  → registry.markResult（ok → nextRunAt = now + interval；BLOCKED → paused）
```

展会发现/补全：

```
POST /api/v1/events/discover
  → 任务队列 event.discover
  → event-search：DeepSeek chat（JSON）或注册表页面启发式扫描
  → event-store.upsert（去重合并：同官网 + 日期兼容 → 同一事件）
  → 任务页可见进度/日志/结果 {created, merged, queries}

POST /api/v1/events/:id/enrich
  → 任务队列 event.enrich
  → 有官网/来源：直接采集；没有：用 DeepSeek Web Search 找官网候选
      → 候选页面抓取并校验标题/字段与事件名匹配 → 才写入 website
      → 优先站点首页（/ 或一级路径），深层 contact/about 页会被升级/跳过
  → JSON-LD Event 优先，其次标题/正文启发式
  → 国家/省/市/区县来自 seed/geo-cn.json（城市/展馆表），不用名称猜测
  → 只填有来源的字段；缺失写 notes（如 未找到报名截止日期、展馆待确认）
  → 官网找不到时把候选 URL 写进 notes（官网候选（待人工确认）：...）
  → 文档链接用 collector.probe 分类 availability（linked/downloadable/restricted/unknown）
```

**不提供"推荐参展/不参展"字段。** 资料只列可核验事实与来源，由公司自行决定。

## 2. API

```
GET  /api/v1/events?from=&to=&region=&status=&q=&limit=
GET  /api/v1/events/:id
POST /api/v1/events/discover          # user+，创建任务 → 202 {task}
POST /api/v1/events/:id/enrich        # user+，创建任务 → 202 {task}
PATCH /api/v1/events/:id              # user+ 手动修正
GET  /api/v1/events/export?format=csv|json
POST /api/v1/events/:id/parse         # admin+；M3d 接口：未配置 OCR → 409，非 downloadable → 409，已配置 → 501（本期不做真实解析）

GET  /api/v1/sources?region=&type=&enabled=
POST /api/v1/sources                  # admin+（sources:manage）
PATCH /api/v1/sources/:id             # admin+ 全量；user 只能 {enabled}（sources:toggle）
DELETE /api/v1/sources/:id            # admin+
POST /api/v1/sources/:id/run          # user+，创建 source.collect 任务 → 202 {task}

GET  /api/v1/recipes?domain=&status=
POST /api/v1/recipes                  # admin+（recipes:manage）
PATCH /api/v1/recipes/:id             # admin+：status proposed|approved|disabled
DELETE /api/v1/recipes/:id            # admin+
POST /api/v1/recipes/:id/test         # admin+：对真实页面执行一次 recipe，返回 {ok, values|error}
```

## 3. 采集器行为

- 只抓公开 http(s) 页面，遵守 robots.txt（`User-agent: *` 的 Allow/Disallow/Crawl-delay，
  Allow 最长匹配优先，缓存 1h）。
- 超时 20s、流式累计 2MB、content-type 仅 text/html / application/xhtml+xml；手动重定向 ≤5。
- 错误分类：`TIMEOUT`/`NETWORK`（可重试）、`TOO_LARGE`/`BAD_CONTENT_TYPE`/`ROBOTS_DENIED`/
  `HTTP_ERROR`（永久）、`BLOCKED`（403/401，永久并暂停域）、`RATE_LIMITED`（429/503，读
  Retry-After 后重试）。
- Playwright 用系统 Chrome（`CHROME_PATH` 或 `/usr/bin/google-chrome`），headless，
  复用实例，进程退出/任务 runner stop 时关闭；仅当正文 < 300 字才回退。
- **recipe**：失败页由 Agent/人工提出 `script`（node:vm 沙箱、无 require/process/fetch、
  1s 超时）/`regex`/`selectors` 三种 recipe，管理员在设置页审批为 approved 后，
  后续确定性复用；未审批不执行。

## 4. 数据文件

```
.local/source-registry.json   {version, sources[], domains{}}
.local/documents.json         {version, documents[]}  采集页面，URL 去重
.local/events.json            {version, events[]}     展会资料库
                               事件含 country/province/city/district/venue 地理层级
.local/recipes.json           {version, recipes[]}    recipe 存储
.local/tasks.json             任务队列（见 docs/TASK_QUEUE.md）
seed/geo-cn.json              国家/省/市/区县与展馆存储表（随仓库分发，不写 .local）
```

删除对应 JSON 可重置；来源注册表在 sources 为空且文件不存在时会从
`seed/sources-cn.json` 重新导入。`.local/` 不进 git。

## 5. 中国首批来源

`seed/sources-cn.json` 预置 30 个中国区来源：展馆（国家会展中心上海、深圳国际会展
中心、广交会展馆、中国国际展览中心、上海新国际博览中心等）、协会（中国制冷学会、
中国建筑学会暖通空调分会、中国通用机械工业协会、中国电器工业协会等）、展会官网
（中国制冷展、ISH China & CIHE、中国国际工业博览会、广交会、中国国际电机博览会）、
媒体（产业在线、冷暖商情、慧聪暖通）以及 Domel 官网/sitemap。

来源是**候选网址**，不保证可抓；抓取失败会记录 `status=error`/`lastError`，
被 WAF 拦截则 `paused`，不影响其他来源。站点规则变化时请在来源页手工停用/修正。

## 6. 测试与真实抓取

单测不联网：`tests/collector.test.mjs`（fixtures + 本地 JS 壳页，Chrome 缺失自动 skip）、
`tests/rate-limit.test.mjs`、`tests/recipes.test.mjs`、`tests/source-registry.test.mjs`、
`tests/scheduler.test.mjs`、`tests/documents.test.mjs`、`tests/event-store.test.mjs`、
`tests/event-jobs.test.mjs`、`tests/event-search.test.mjs`、`tests/geo.test.mjs`、
`tests/event-jobs-website.test.mjs`、`tests/events-api.test.mjs`、
`tests/sources-api.test.mjs`、`tests/recipes-api.test.mjs`。

## 7. 升级与地理回填

新增展会城市/展馆时，先扩展 `seed/geo-cn.json`（cities / venues 条目，含中英文别名、
省份、区县），再部署。旧事件补齐国家/省/市/区县（并清理过期的"缺少官网"notes）：

```bash
# 单进程 JSON 存储：先停服务
node scripts/backfill-event-geo.mjs          # 或 npm run event:backfill-geo
# 可用 EVENTS_FILE / GEO_FILE 指向其他数据目录
```


真实抓取只在验收时执行：Domel 官网、公开展会官网与注册表页面；发现/补全的真实运行
记录写在 `evidence/`。
