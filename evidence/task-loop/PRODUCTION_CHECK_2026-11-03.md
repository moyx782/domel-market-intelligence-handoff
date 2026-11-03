# Production mode acceptance — 2026-11-03

Code: final M1–M5 iteration (geo + website enrichment). Build via `npm run build` (tsc -b + vite).
The original production run was at commit `ff8ec2b`; the final iteration repeated the HTTP
and browser checks with the current build (see logs, same filenames).
Environment: Node v22.23.4, Chrome 156.0.8078.79, isolated data `/tmp/domel-acceptance-prod`
(copy of the acceptance data dir; the repository `.local/` was not touched).

## Why two builds

The shipped build resolves the API base as `http://<page-hostname>:8788` in local mode (documented
demo port). The production acceptance therefore used:

1. the checked-in `dist/` build for the HTTP contract checks (single process on 8792 with
   `SERVE_STATIC=1 STATIC_DIR=dist`), and
2. a second build with `VITE_BACKEND_URL=http://127.0.0.1:8792` (output in `/tmp/domel-prod-dist`)
   for the browser end-to-end pass on 8792, so the page and API are genuinely same-origin.

## HTTP contract

Command/log: `evidence/task-loop/PRODUCTION_HTTP_2026-11-03.log`.

| Check | Result |
|---|---|
| `GET /health` | 200 `{"status":"ok","architecture":"local-single-user"}` |
| `GET /` + same-origin `Origin: http://127.0.0.1:8792` | 200 `text/html; charset=utf-8`, contains `id="root"`, references `/assets/index-ErZc3dlh.js` and `/assets/index-BhLpZxXR.css` |
| `GET /assets/*.js` + same-origin `Origin` | 200 `text/javascript`, immutable cache header |
| `GET /assets/*.css` + same-origin `Origin` | 200 `text/css`, 58 417 bytes |
| `GET /events/deep/link` (SPA fallback) + same-origin `Origin` | 200 `text/html`, contains `id="root"` |
| `GET /api/v1/workspace` + same-origin `Origin` | 200 JSON (2 projects) |
| `GET /api/v1/workspace` + `Origin: https://evil.test` | **403** `{"error":"Frontend origin is not allowed"}` |
| `GET /api/v1/workspace` without `Origin` | 200 |
| `GET /` + `Origin: https://evil.test` | 200 — static pages are public; the origin gate applies to `/api/` only and no `Access-Control-Allow-Origin` is emitted for foreign origins, so foreign JS cannot read API responses |
| `GET /favicon.svg` + same-origin `Origin` | 200 `image/svg+xml` |

## Browser end-to-end (production bundle, same origin)

Command/log: `evidence/task-loop/PRODUCTION_BROWSER_2026-11-03.log`.

- `GET /` renders the Events home: heading “Event calendar”, 9 event cards, 6 navigation pages.
- Document title `Domel · Market Intelligence`.
- SPA fallback `GET /events/deep/link` renders the application (Events heading).
- 0 console errors, 0 page errors, 0 HTTP responses ≥ 400.
- Screenshots: `evidence/ui-acceptance/44-production-home.png`,
  `evidence/ui-acceptance/45-production-spa-fallback.png`.

## Regression context

The same-origin static serving was a real defect found during acceptance (BUG-2): Vite emits
`crossorigin` on script/link tags, so browsers send an `Origin` header even for same-origin
requests; the old allowlist rejected them with 403 and the production page was blank. The fix
(origin == Host ⇒ allowed; cross-origin still allowlisted; CORS headers only for allowlisted
cross-origin) is what these checks verify. `tests/static.test.mjs` keeps the regression.
