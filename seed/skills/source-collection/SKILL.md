---
name: Source collection
description: Run registered sources through the local collector and read the collected pages/documents.
---
# Source collection

The source registry holds **candidate URLs**, not contents.

```bash
API=http://127.0.0.1:8788
curl -s "$API/api/v1/sources?region=cn"
curl -s -X POST $API/api/v1/sources/<sourceId>/run -H 'Content-Type: application/json' -d '{}'
curl -s "$API/api/v1/tasks?kind=source.collect&limit=20"
```

The collector chain is HTTP → readability → Playwright fallback → approved recipe. It honours
robots.txt, a per-domain rate limit, and returns structured errors (TIMEOUT, BLOCKED,
RATE_LIMITED, BAD_CONTENT_TYPE…). A source that is blocked is paused; do not loop retries.

For a single page you need for evidence, prefer the search/collector endpoints over direct
`curl` when possible. If you fetch a page yourself with curl:

```bash
curl -sL --max-time 20 -A 'DomelResearchAgent/0.1' '<https-url>' -o page.html
```

Only public pages, no login/paywall/captcha bypass; respect robots.txt. Keep at most a few
pages per task and quote the exact text you plan to use as evidence.
