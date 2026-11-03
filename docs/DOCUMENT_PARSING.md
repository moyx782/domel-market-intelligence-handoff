# 文档与 OCR：MinerU 接入预定义

规则：**先给链接与「是否可获取」，不强行 OCR。**

展会资料里经常出现 PDF 参展商名单、展位图、招展手册。系统先登记链接和可获取性；只有明确可下载、且管理员启用解析时，才把文件交给 MinerU。

## 可获取性

| 状态 | 含义 |
|---|---|
| `linked` | 只是一个网页链接，可能还需要点击才能看到文件 |
| `downloadable` | 直接的 PDF / DOCX / XLSX / 图片等文件地址（按扩展名判断，不下载） |
| `restricted` | 需要登录、付费或表单才可获取 |
| `unknown` | 无法判断（非 HTTP、畸形 URL 等） |

接口：`GET /api/v1/ocr/status` 返回当前 provider、是否配置、baseUrl 与策略；**永远不返回 token**。

## 两种部署

| provider | 用途 | 配置 |
|---|---|---|
| `official` | MinerU 官方 API（mineru.net） | `MINERU_PROVIDER=official`<br>`MINERU_API_TOKEN=...`（也可在网页设置中填写/替换）<br>`MINERU_API_BASE=https://mineru.net/api/v4`（默认） |
| `local` | 自建 `mineru-kit api-server` | `MINERU_PROVIDER=local`<br>`MINERU_LOCAL_URL=http://127.0.0.1:8000`（可自定义；设置页选择 local 时自动填入） |
| `none` | 默认关闭 | 不设置或 `MINERU_PROVIDER=none` |

设置页把两个地址合并为一个 **API 地址**：选择“MinerU 官方 API”时自动填入 `https://mineru.net/api/v4`，选择“自建 MinerU”时自动填入 `http://127.0.0.1:8000`，均可再修改。

`MINERU_LOCAL_URL` 与 `MINERU_API_BASE` 允许任意 http(s) 主机、端口和基础路径，例如 `https://mineru.corp.example:8443/api` 或 `http://10.0.0.5:9000/mineru`。管理员可以在网页设置中覆盖 provider、两个地址和 token（`PATCH /api/v1/agent/settings` 的 `ocr` 字段），配置优先于环境变量。

密钥规则：token 只写不读。设置接口可以写入或清空；读取配置只返回 `tokenSet: true/false`，任何角色都拿不到明文；`agent-config.json` 以 0600 权限保存。MCP 的 env/headers 对 user/viewer 打码，admin 才能看到明文。

自建服务：

```bash
mineru-kit api-server --host 0.0.0.0 --port 8000 --tier standard
# OpenAPI: http://127.0.0.1:8000/docs
```

官方 API 文档：<https://mineru.net/apiManage/docs>；开源自部署：<https://github.com/opendatalab/MinerU>。

## 代码接口（已预定义）

`server/mineru.mjs`：

```js
mineruConfig(env)        // provider / baseUrl / token / timeout / configured
mineruStatus(env)        // 公开状态，不含 token
documentAvailability(url)// linked / downloadable / unknown
parseDocument()          // 预留；本阶段调用会明确失败，避免误判“已解析”
```

## 官方 API 的后续实现步骤（尚未启用）

1. 以官方文档为准创建解析任务（文件上传或 URL 提交）。
2. 轮询任务状态，拿到结果压缩包（Markdown + 图片）。
3. 解压、保存到 `.local/documents/<eventId>/`，记录 `parseProvider`、`parsedAt`、页数与失败原因。
4. 解析失败不影响链接与可获取性展示；重试走任务队列。

> 官方 API 的路径与轮询格式以 mineru.net 当前文档为准，实现时先做一次真实冒烟再固化。

## 安全与成本

- token 存在服务端环境变量或 `.local/agent-config.json`（0600）；状态接口与前端只看到 `configured` / `tokenSet`，从不返回明文。
- 官方 API 按量计费；自建需要 GPU 与模型下载，默认不随项目启动。
- 单文件上限、超时、页数上限由配置控制；大文件先记录链接，不自动下载。
- 不绕过登录、付费墙或验证码；`restricted` 只展示链接。
