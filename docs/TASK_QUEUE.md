# 持久任务队列与任务页（M1/M2）

本文件说明单主机 Demo 的任务队列、任务 API 和前端任务页。实现位于
`server/task-queue.mjs`（队列核心）、`server/task-runner.mjs`（接线与 job handlers）、
`server/local-api.mjs`（HTTP/SSE）、`src/Tasks.tsx`（任务页）。

## 1. 设计

- **单 worker、单 JSON**：一个进程、一个 `.local/tasks.json`，写入用 tmp + rename
  原子替换。接口保持通用，后续可换 Postgres/分布式队列。
- **所有后台工作都走队列**：研究（`project.research` / `project.extract`）、来源采集
  （`source.collect`）、展会发现/补全（`event.discover` / `event.enrich`）。
  API 只创建/取消/重试任务，不直接执行。
- **可恢复**：进程重启时 `running` 任务回到 `queued`，attempts 保留。崩溃在最后一次
  允许启动上的任务补跑一次后才 failed。
- **可取消**：排队任务立即取消；运行中任务通过 AbortController 通知 handler，最终
  状态仍是 `cancelled`，不会因为 handler 已完成就变成 succeeded。
- **可观测**：任务有 `progress`、`result`、`error`、最多 60 条日志；订阅走 SSE。

## 2. 调度语义

| 规则 | 取值 |
|---|---|
| 优先级 | 0–3，**3 最高（P0）** |
| 防饥饿 | `effectivePriority = min(3, priority + floor((now - createdAt) / 300000))` |
| 并发 | 默认 1（`TASK_CONCURRENCY`） |
| 去重 | 同 `kind + projectId + eventId + sourceId` 存在 queued/running 时复用 |
| 重试 | 第 1/2/3 次启动分别失败后 5s / 30s / 120s 再排；3 次后 failed |
| 永久错误 | handler 抛 `error.permanent = true` 直接 failed，不重试 |
| 取消 | `queued → cancelled`；`running → cancelRequested + abort → cancelled` |
| 重试 | 仅 failed/cancelled；重置 attempts/error/notBefore 后重新排队 |
| 限流 | 单来源 `intervalSec ≥ 30`；每域令牌桶默认 5s，`max(配置, robots Crawl-delay)`；429/503 读 `Retry-After` 退避；403/WAF 暂停该域 |

## 3. 任务 API

```
GET  /api/v1/tasks?state=&kind=&projectId=&eventId=&sourceId=&limit=
     → {tasks: Task[], stats: {queued,running,succeeded,failed,cancelled}}
GET  /api/v1/tasks/:id               → Task（不存在 404）
POST /api/v1/tasks/:id/cancel        → Task（user+；运行中返回 running+cancelRequested）
POST /api/v1/tasks/:id/retry         → Task（user+；仅 failed/cancelled）
GET  /api/v1/tasks/stream            → SSE
```

SSE 事件（`text/event-stream`，15s keep-alive 注释行）：

```json
{"type":"snapshot","tasks":[...],"stats":{...}}
{"type":"task","task":{...}}
```

订阅时立即收到 snapshot，之后每个任务状态/日志变化收到 task（前端按 id 覆盖即可），
断线由 EventSource 自动重连并重新收到 snapshot。

创建任务的接口：

```
POST /api/v1/events/discover        body {region?, query?, limit?}  → 202 {task}
POST /api/v1/events/:id/enrich                                     → 202 {task}
POST /api/v1/sources/:id/run                                       → 202 {task}
POST /api/v1/research-tasks/:id/run                                → 202 {job, taskId, taskState}
```

## 4. Task 字段

```ts
{
  id, kind, state, priority, effectivePriority, attempts, maxAttempts, notBefore,
  projectId, eventId, sourceId, payload, progress, result, error,
  log: [{at: ISO, message, level: 'info'|'warn'|'error'}],
  createdAt, updatedAt, startedAt, finishedAt, cancelRequested?
}
```

`src/types.ts` 里有对应 TypeScript 类型；`src/api.ts` 提供
`getTasks/getTask/cancelTask/retryTask/streamTasks`。

## 5. 重启与停机

- `SIGINT/SIGTERM`：API 先 `tasks.stop()`（abort 运行中的 handler、 scheduler 停止），
  再关 HTTP server，800ms 兜底退出。
- 手工恢复：直接重启进程即可；`.local/tasks.json` 保留历史任务。
- 不要对同一 `.local/` 同时起两个进程（JSON 写入没有跨进程锁）。

## 6. 测试

```bash
node --test tests/task-queue.test.mjs      # 队列核心：16 个用例
node --test tests/task-runner.test.mjs     # 队列 + 研究/采集/展会 handler 集成
node --test tests/task-api.test.mjs        # 任务 API/SSE/权限
```

验收覆盖：优先级顺序、防饥饿、重试退避、去重、取消（排队/运行中）、retry、重启
恢复、永久错误、订阅事件、研究任务生命周期、来源采集与 domain 暂停、展会
discover/enrich、scheduler 入队。

## 任务页：折叠式查看详情

任务列表是**内联折叠列表**：详情不会跑到页面底部，而是在选中任务行的正下方展开一行。

三种展开方式：

1. 点击整行（任意位置）——再次点击同一行收起；
2. 点击任务类型名称按钮；
3. 点击行尾 **View details / 查看详情** 按钮（展开后变为「Hide details / 收起详情」，
   所有角色可见；viewer 只有查看，没有 Cancel/Retry）。

展开的详情包含状态/进度/优先级/重试次数/耗时、payload、result、错误和日志时间线；
右上角关闭按钮收起。一次只展开一条任务，100+ 条任务时不会出现“点了没反应”或整页跳动。
桌面与 390×844 移动端行为一致。
