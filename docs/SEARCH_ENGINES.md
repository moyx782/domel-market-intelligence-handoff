# 搜索引擎（用于查找展会官网）

展会资料里的"官方网站"必须来自**搜索**，且搜索结果只是候选：系统会抓取页面、校验标题/字段与
事件名匹配、并拒绝论坛/媒体/目录页，才写入 `website`。本文说明如何对接**本地部署的搜索
引擎**，避免依赖外部搜索服务。

## 1. 为什么需要

用户反馈过：某些展会的"官网"被写成了论坛帖子（如 `eechina.com/thread-...`、
`eeworld.com.cn/bbs/thread-...`）。现在有两道保护：

1. **URL 质量门**（`server/event-search.mjs` 的 `isLikelyOfficialUrl`）：拒绝论坛
   `/thread`、`/bbs`、`/forum`、新闻 `/news`、文章 `/article`、`/blog`、`/contact`、
   `/about`、`/download` 等路径，以及 UGC/媒体/目录域名；只接受站点根或落地页。
2. **页面匹配**：抓取候选页后，标题/JSON-LD 必须与事件名有有效 token 重叠，才可能成为官网。

## 2. 配置（`.env.host`）

```dotenv
# auto（默认）：DeepSeek 模型有 key 时用 DeepSeek search 工具；
# 否则如果配置了本地搜索 URL，就用本地搜索引擎；否则不搜索。
WEB_SEARCH_PROVIDER=auto            # auto|deepseek|searxng|custom|none
WEB_SEARCH_URL=http://127.0.0.1:8080 # SearXNG 地址，或自定义 JSON 网关地址
# SEARXNG_URL=http://127.0.0.1:8080  # WEB_SEARCH_URL 的别名
# WEB_SEARCH_API_KEY=               # 自定义网关可选 Bearer token
WEB_SEARCH_LANGUAGE=zh-CN
WEB_SEARCH_TIMEOUT_MS=12000
```

修改后重启 API 生效（这是进程级配置，和 AI 模型 UI 配置不同）。

## 3. 方案 A：SearXNG（推荐，本地部署）

[SearXNG](https://github.com/searxng/searxng) 是开源自建聚合搜索，支持 JSON API，
可用 Docker 在内网运行。

```yaml
# docker-compose.yml（单独放一个目录）
services:
  searxng:
    image: searxng/searxng:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"   # 只给本机/内网使用
    environment:
      - SEARXNG_BASE_URL=http://127.0.0.1:8080/
    volumes:
      - ./searxng:/etc/searxng
```

`./searxng/settings.yml` 必须开启 JSON 格式（SearXNG 默认只开 html）：

```yaml
use_default_settings: true
server:
  secret_key: "replace-with-random"
search:
  formats:
    - html
    - json
```

启动并验证：

```bash
docker compose up -d
curl -s 'http://127.0.0.1:8080/search?q=%E4%B8%AD%E5%9B%BD%E5%88%B6%E5%86%B7%E5%B1%95%20%E5%AE%98%E7%BD%91&format=json' \
  | head -c 500
```

然后 `.env.host` 设：

```dotenv
WEB_SEARCH_PROVIDER=searxng
SEARXNG_URL=http://127.0.0.1:8080
```

这样即使**不用 DeepSeek 的搜索工具**（例如公司只允许内网搜索/本地模型），展会补全也能
通过内网 SearXNG 找官网候选。

## 4. 方案 B：内部 JSON 搜索网关（自研/已有搜索服务）

若公司已有 Elasticsearch/OpenSearch/Meilisearch/自研搜索，包一层简单 HTTP 接口即可：

```
GET {WEB_SEARCH_URL}[?q={query}&limit={n}]      # URL 里可用 {query} 占位
Authorization: Bearer {WEB_SEARCH_API_KEY}      # 可选
→ {"results":[{"url":"https://...","title":"..."}]}
```

也支持 `{items:[...]}` / `{data:[...]}` 形状；URL 模板示例：

```dotenv
WEB_SEARCH_PROVIDER=custom
WEB_SEARCH_URL=https://search.corp.example/api/search?q={query}&limit=5
WEB_SEARCH_API_KEY=your-internal-token
```

## 5. 方案 C：DeepSeek 搜索工具（默认）

`.env.host` 有 `DEEPSEEK_API_KEY` 且 AI 模型为 DeepSeek 时，默认使用 DeepSeek 的
search 工具，无需额外部署。若 AI 模型切到本地 OpenAI 兼容模型（设置 → AI 模型），
DeepSeek 搜索工具不可用；此时请在 `.env.host` 配本地搜索（方案 A/B），否则展会补全
只能基于已有官网/来源链接。

## 6. 验证与排查

```bash
# 1) 单独验证搜索服务（以 SearXNG 为例）
curl -s "http://127.0.0.1:8080/search?q=ISH+China+CIHE+官网&format=json" | head -c 300

# 2) 触发一次展会补全
curl -X POST http://127.0.0.1:8788/api/v1/events/<id>/enrich \
  -H 'Content-Type: application/json' -d '{}'
# 3) 任务日志里应出现「官网搜索：N 个候选，优先核验 ...」
curl -s http://127.0.0.1:8788/api/v1/tasks/<taskId> | python3 -m json.tool | grep -A2 log
```

常见问题：

| 现象 | 检查 |
|---|---|
| 任务日志提示 `search failed` / 搜索失败 | `WEB_SEARCH_URL` 是否可达；SearXNG 是否开启 `json` 格式 |
| 永远拿不到官网 | 搜索内容里只有论坛/媒体页；现在会被拒绝并写“搜索候选只有论坛/媒体页面” |
| SearXNG 返回 403 | 只绑定了 127.0.0.1 时需在同机调用；跨机请监听内网地址并做访问控制 |
| 搜到的是往届页面 | 页面匹配成功但日期是上一届 → 写“上一届日期待确认”，不会当成 upcoming |

## 7. 清理历史错误官网

旧版本/错误搜索结果可能已经把论坛页写成官网。停止服务后运行：

```bash
node scripts/clean-event-websites.mjs     # 或 npm run event:clean-websites
```

它会把论坛/媒体/目录页从 `website` 清掉、在 `notes` 记录原链接，并尝试从已存 `sources`
中恢复一个看起来像官网的链接。之后可对相关事件再执行一次“补全资料”。

## 8. 安全边界

- 本地搜索服务只在内网监听，不要暴露公网；SearXNG 建议加反向代理认证与限流。
- 搜索结果只作为候选，不直接当证据；官网仍以抓取页面 + 匹配校验为准。
- 抓取遵守 robots.txt 与站点条款，不绕登录/付费墙/验证码。
