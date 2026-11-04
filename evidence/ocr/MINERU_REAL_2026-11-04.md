# MinerU Token 真实解析验证（复用前端 Token）

日期：2026-11-04
环境：本机 demo `.local/agent-config.json` 中由前端设置页保存的 OCR 配置：
`provider=official`、`baseUrl=https://mineru.net/api/v4`、`tokenSet=true`（不记录 token）
测试文档：`evidence/ocr/fixtures/ocr-smoke-scan.pdf`（无文本层扫描件）

## 结果

- 走 **MinerU Standard API**：`file-urls/batch` 上传 → 轮询 → 下载 zip → `full.md`
- 返回：`provider=mineru-vlm`、`method=mineru-batch`、`chars=47`
- 识别文本：
  ```
  中国国际制冷展 2026
  上海新国际博览中心
  China Refrigeration Expo
  ```
- 未使用环境变量 token；使用的是前端设置页保存的 token（`getMineru: () => agentStore.ocr()`）
- token 未在任何日志/接口回显；状态接口仅返回 `mineru.tokenSet=true`、`modelVersion=vlm`

## 与视觉 OCR 对比

| 渠道 | 本次结果 | 说明 |
|---|---|---|
| MinerU Token（`vlm`） | `mineru-vlm`，47 字符正确 | 前端 token 复用、Standard API、zip Markdown |
| 视觉 OCR（DeepSeek） | `vision-ocr`，61 字符正确 | 无 MinerU token 时的兜底 |
| pdftotext | 不适用 | 该 PDF 无文本层，自动跳过 |

结论：Token 渠道已接通，前端填入的 Token 可直接复用；复杂/扫描文档优先 MinerU vlm，
失败或无 token 时视觉 OCR 兜底。
