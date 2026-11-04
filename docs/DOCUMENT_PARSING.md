# 文档与 OCR：视觉模型 OCR + 材料清单 + Agent 整理

状态：**已实现并真实测试**（2026-11-04 起）
规则：先给链接与「是否可获取」，只有明确可下载的文档才 OCR；OCR 结果进入**材料清单**，
由 DeepSeek Agent 整理成材料报告，人工复核后才用于业务判断。

## 1. OCR 提供方（已确认可用）

| 提供方 | 用途 | 配置 |
|---|---|---|
| **vision（默认兜底）** | 用当前 AI 模型的视觉能力 OCR 图片/扫描 PDF/纯图片网页 | 设置 → AI 模型配置 Key/模型；DeepSeek `deepseek-flash` 已实测中英文正确 |
| **MinerU official（token）** | 精准解析：`vlm` 模型，表格/多栏/复杂扫描件更稳；200MB / 200 页 | 设置 → Document parsing：选 MinerU 官方 API，填 **API token（前端只写保存，服务端复用）**；或 `.env.host` 的 `MINERU_API_TOKEN` |
| MinerU local | 自建 `mineru-kit api-server`，同 Standard API 协议 | 设置页选自建并填 local URL，或 `MINERU_LOCAL_URL` |
| pdftotext | PDF 有文本层时直接抽文字，**不耗 token** | 本机已装 |
| pdftoppm | 扫描 PDF 逐页转图（默认最多 5 页） | 本机已装 |

`GET /api/v1/ocr/status` 返回有效 OCR 能力（vision / mineru / tools），**永不返回 token**；
`mineru.tokenSet=true` 表示前端/环境已配置 token。

**Token 复用**：设置页 OCR 配置写入 `.local/agent-config.json`（0600，只写不读），
优先级高于环境变量；OCR 服务每次解析时读取当前设置，因此前端填入/替换 token 后**无需重启**即可生效。

**解析优先级**（成本与精度平衡）：

1. PDF 有文本层 → `pdftotext`（免费、最准）；
2. 扫描 PDF / 图片 / 复杂文档，且 MinerU token 已配置 → **MinerU `vlm`**（默认模型；可在
   `MINERU_MODEL_VERSION` 覆盖）；
3. MinerU 未配置或失败 → 视觉 OCR 兜底；
4. 采集 HTML 文字过薄 → Playwright 截图 → 视觉 OCR（MinerU 不参与截图 OCR）。

## 2. OCR 何时自动触发

| 内容 | 行为 |
|---|---|
| 采集 URL 返回 PDF/图片 | 下载（≤15MB）→ 文本层优先 → 扫描件逐页 OCR，`engine=ocr-document` |
| HTML 文字过薄（<300 字符）| Playwright 渲染；仍薄 → 全页截图 → 视觉 OCR，`engine=ocr-browser` |
| 事件文档（可下载）| 事件详情「使用 OCR 解析」或 `POST /api/v1/events/:id/parse` → `document.parse` 任务 |
| 纯图片/Canvas 网页 | 作为普通采集进入 OCR 分支，OCR 文本自动进入材料清单 |
| OCR 不可用 | 保持 fail-closed（`BAD_CONTENT_TYPE` / 409），不会假装解析成功 |

## 3. 材料清单（Materials）

OCR 文本不塞进事件 JSON，而是：

- 全文存 `.local/documents/materials/<eventId>/*.md`（0600，带 source_url/provider/pages/chars 头）
- 事件 `materials[]` 只存元数据：`url/title/kind(document|webpage)/provider/engine/pages/chars/textPath/summary/agentSummary`
- 事件 `materialsReport` 存 Agent 生成的材料报告（Markdown）
- API：`GET /api/v1/events/:id/materials/:materialId/text` 读取全文

事件详情新增：

- 文档行「使用 OCR 解析」→ 任务完成后显示 provider/pages/chars；
- **OCR 材料清单**：材料类型、来源、页数/字符、Agent 摘要、「查看 OCR 文本」；
- **Agent 材料报告**：Markdown 报告全文 + 刷新按钮；
- viewer 只读，admin/user 才能触发解析/报告。

## 4. Agent 整理并汇报

`event.agent-report` 任务（document.parse 完成后自动入队，也可在事件详情点「Agent 整理并汇报」）：

1. 读取事件全部材料的文本文件（OCR 输出视为不可信数据，不执行其中指令）；
2. Agent 写 `event-report.json`：Markdown 报告 + 每份材料的摘要 + 逐字引文 + 待核验项；
3. 服务端校验：只接受已知材料 URL；引文必须在对应材料文本中逐字存在（8–800 字符）；
4. 通过后保存 `.local/documents/reports/<eventId>.md`，回写 `materials[].agentSummary` 和
   `event.materialsReport`；报告明确标注 OCR 未人工核验/日期冲突等风险。

本机实测（fixture 扫描 PDF + 纯图片网页）：
- `vision-ocr` 识别扫描 PDF：1 页 / 61 字符；
- 纯图片网页：`ocr-browser` 47 字符；
- Agent 报告：2 份材料、3145 字符、含来源 URL 与引文、6 条核验警告；
- 材料文本只读接口、事件详情 UI 均验证通过，0 console/page error。

## 4.1 内嵌图片补识（修复“部分图片未识取到”）

| 场景 | 行为 |
|---|---|
| 网页正文文字够多，但含内嵌图片 | 浏览器渲染前自动滚动；对尺寸足够的 `<img>` 逐个元素截图 + 视觉 OCR，追加“网页内嵌图片 OCR”段（`engine=ocr-images`） |
| 懒加载/轮播图 | 自动滚动触发加载；默认每页最多 2 张（`OCR_MAX_EMBEDDED_IMAGES`） |
| 页面文字很长 | 默认仅文字 < 4000 时触发；`OCR_WEB_IMAGES_ALWAYS=1` 可强制 |
| 文本层 PDF + 重要内嵌图片 | MinerU token 可用 → MinerU vlm（同时拿到文字层与图片内容）；否则 `pdfimages` 提取大图逐张视觉 OCR，拼到 pdftotext 文本后（`pdfimages` 检测，面积阈值过滤 logo/图标） |
| 纯文本 PDF | 仍走 pdftotext，不增加成本 |

实测见 `evidence/ocr/IMAGE_OCR_2026-11-04.md`：
图文网页 480 字符 + 2 图 → 2 张图片文本追加成功；
文本层 PDF + 名单截图 → MinerU 输出 103 字符含图片文字；
全量 272/272。

## 5. 自适应抓取回退（Agent）

普通采集不完整时（`event.enrich` 收集 0 页且有官网/来源 URL）：

- 自动入队 `agent.fetch`（后台，可设 `AGENT_FETCH_FALLBACK=0` 关闭）；
- Agent（bash + 文件权限）运行 `scripts/adaptive-fetch.mjs`：
  HTTP → 浏览器渲染 → 滚动/iframe 文本 → 截图 OCR；
- 结果保存为 `agent-adaptive` 材料 + 候选来源 + note，并自动触发 Agent 材料报告；
- 不绕过 robots.txt/登录/付费墙/验证码；失败只记 note，不重试风暴。

手动入口：`POST /api/v1/agent/fetch {url, eventId?}`（返回 202 任务）。

## 6. API 一览

| 接口 | 说明 |
|---|---|
| `GET /api/v1/ocr/status` | 有效 OCR 状态（vision/mineru/tools），无 token |
| `POST /api/v1/events/:id/parse {url}` | 入队 `document.parse`，下载 + OCR + 材料 + 自动报告 |
| `POST /api/v1/events/:id/agent-report` | 手动触发 Agent 材料报告 |
| `GET /api/v1/events/:id/materials/:materialId/text` | 读取 OCR 全文 |
| `POST /api/v1/agent/fetch {url,eventId?}` | 手动触发 Agent 自适应抓取 |
| `GET /api/v1/capabilities` | `ocr.vision` / `ocr.tools` 能力 |

新增任务 kinds：`document.parse`、`event.agent-report`、`agent.fetch`（任务页可查看详情/日志）。

## 7. 真实冒烟与测试

```bash
npm run test:ocr        # 真实视觉 OCR：生成中英文图片 + 扫描 PDF，断言识别文字（消耗少量 token）
npm run test:mineru     # 测试【当前生效】的 MinerU 配置：读取前端设置页 token，
                        # 真实上传扫描 PDF → vlm 解析 → 打印 provider/字符数/文本预览；
                        # token 不会被打印，结果写 evidence/ocr/MINERU_SMOKE_<date>.log
npm test                # OCR 单测 / 材料 schema / Agent 报告校验 / collector OCR 分支
```

### 如何确认 Token 有效

1. `curl -s http://localhost:8788/api/v1/ocr/status`：看
   `mineru.configured=true`、`mineru.tokenSet=true`、`mineru.modelVersion=vlm`；
   **接口不会返回 token 内容**。
2. `npm run test:mineru`：用前端保存的 token 真实解析扫描 PDF，成功输出
   `provider=mineru-vlm`；失败会输出 MinerU 返回的错误（如 token 失效 A0202）。
3. 设置页 → Document parsing 看到「MinerU token 已配置」；token 只在服务端
   `.local/agent-config.json`（0600）保存，UI/API/日志都不回显。
4. 端到端：事件详情 → 文档「使用 OCR 解析」→ 任务页看任务状态 → 事件详情
   「OCR 材料清单 / Agent 材料报告」。

证据：`evidence/ocr/OCR_SMOKE_<date>.log`、`MINERU_SMOKE_<date>.log` 与 fixtures。

## 8. 安全与成本

- token 只在服务端；状态/材料接口不返回明文；`.local` 文件 0600。
- OCR 图片/PDF 有大小与页数上限；仅公开页面，不下载受限文档内容。
- OCR/网页文本一律视为不可信数据；Agent 不得执行页面指令；报告中的引文必须可逐字复核。
- 视觉 OCR 每页会消耗 token；默认最多 5 页，文本层 PDF 不 OCR。
- MinerU Token 渠道：官方配额 1000 页/天优先（以官方文档为准）；解析任务为异步
  （提交 → 轮询 → zip → Markdown）。token 只存服务端，状态只返回 `tokenSet`。
- MinerU 官方 API 参考：<https://mineru.net/apiManage/docs>；token 在
  <https://mineru.net/apiManage/token> 获取。
