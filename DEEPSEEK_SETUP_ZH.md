# DeepSeek Search / Fetch 接入

更新：2026-10-21。代码已实现并通过离线测试；尚未在真实 Supabase 部署或调用用户 Key，不能视为线上验收通过。

## 在现有 Supabase 项目配置

项目：skjtqpuetfrzahrnbdyb。无需新建项目或重新执行数据库迁移。

1. 打开项目的 Edge Functions → Secrets。
2. 新增 `DEEPSEEK_API_KEY`，值为你已创建的完整 DeepSeek Key。在控制台直接粘贴，不发到聊天、截图、前端或代码仓库。
3. 保持原有 Supabase 内置密钥和 JWT 验证。首次验收仅需 DeepSeek 搜索 Key，不需要 AI_MODEL。
4. 当前没有预选数据源，`SOURCE_DEFAULT_URLS=[]`。用户 URL、未来团队默认 URL 和自动搜索同时参与采集，不再只允许 `www.ebmpapst.com`。旧 `SOURCE_ALLOWED_DOMAINS` 已停用；若管理员确需限制访问，可单独设置 `SOURCE_RESTRICT_DOMAINS`（默认留空，允许公共 HTTPS 网站）。偏好来源不应写入限制列表。
5. 打开 research → Code，将 `supabase/dashboard/index.ts` 的全部内容替换到控制台的 index.ts，并部署。该文件已内联所有共享模块；不要只复制原始多文件入口。
6. 若已配置 Supabase CLI，也可在当前项目目录执行 `supabase functions deploy research --project-ref skjtqpuetfrzahrnbdyb`。本次环境未发现可用 CLI 会话，未执行部署。

## 行为

- 有 `DEEPSEEK_API_KEY`：无来源URL时调用 DeepSeek Search，随后 Fetch 正文；有URL时直接 Fetch。使用固定官方地址，禁止凭据随重定向转发。
- 没有该 Key：保留原先的手动URL/直接HTML采集，以及可选 Tavily 搜索路径。
- 搜索每个竞争者最多1次，共最多3次；每次最多5条结果。结果重新检查HTTPS、用户信息、端口、精确域名并去重。
- 每次研究最多抓取5个来源。更多URL明确提示覆盖不完整。每个请求超时12秒、响应最多2MB、正文最多24000字符。来源数量/总体执行预算仍有限，未保证每次都能收集5页。
- Fetch 的 Markdown 正文才作为来源文本；不使用搜索摘要替代原文。
- Fetch 返回的正文没有可验证发布日期，因此 `published_at` 保留未知，不把搜索索引日期当作已验证发布日期。季度相关性仍需人工审核。
- 部分搜索失败或部分网页被拒绝仍保存成功取得的来源，并记录限制；错误信息不转发服务原始响应或密钥。
- 本次只接 Search / Fetch；`research` 模式仍需已有的 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`。不要仅凭搜索 Key 就宣称已完成 AI 提取。

## 首次真实验收

1. 用现有真实账号登录本地网站。
2. 新建测试研究：竞争者 `ebm-papst`，领域 `EC motors for HVAC`，市场 `European Union`，季度按实际研究选择；来源URL留空。
3. 点击 `Collect public sources`。此动作会产生正常的 DeepSeek Search / Fetch 请求费用。
4. 等待状态结束，检查成功来源标题、URL、实际正文、抓取时间和失败/缺失提示。0个结果也是实际结果，不能补造内容。
5. 刷新并重开项目，核对来源保留；导出预览JSON并保存证据。
6. 先用同一官网已知URL再测一次，可区分 Search 搜索结果问题与 Fetch 抓取问题。

401检查Key；402检查余额；429稍后重试；403/404表示页面被拒绝或没有可读正文。首次只采集来源，不点击AI提取按钮。

## 文件与验证

- 适配器：supabase/functions/_shared/deepseek-search.mjs
- 原始入口：supabase/functions/research/index.ts
- 控制台粘贴版：supabase/dashboard/index.ts
- 测试：tests/deepseek-search.test.mjs
- 官方文档：https://api-docs.deepseek.com/zh-cn/guides/search/
- 2026-10-21 离线验证：类型检查、构建、25项测试通过；原始日志见 evidence/runs/2026-10-21T02-50-22-743Z/。后续UI文案调整只另做构建检查。

线上部署、真实Key鉴权、实际搜索结果/余额计费、来源持久化及本地页面新版本仍待部署后实测。


详见 [来源采集策略](docs/SOURCE_COLLECTION.md)。填写 URL 不会关闭搜索；搜索异常会保留提示并继续处理已有 URL。
