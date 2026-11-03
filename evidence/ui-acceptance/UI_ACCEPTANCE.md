# UI acceptance — M1–M5 task loop, event library, agent and settings

Date: 2026-11-03 (Asia/Shanghai)
Code: final M1–M5 iteration (geo hierarchy + official-website enrichment; see `git log`).
The original acceptance cycle ran at `ff8ec2b`; the final iteration re-ran the full browser
(187/187), API (175/175) and production checks after the geo/website changes.
Browser: Google Chrome 156.0.8078.79 via playwright-core 1.49.1, headless
Viewports: 1440×1000 desktop and 390×844 mobile
Frontend under test: `http://127.0.0.1:5176` (Vite dev server, `VITE_BACKEND_URL=http://127.0.0.1:8791`)
API under test: `http://127.0.0.1:8791` (local demo API, frozen code)
Data: isolated `/tmp/domel-acceptance` (never the repository `.local/`); see data note below
Acceptance member: qa-verify (independent; no business code was modified during acceptance)

## Result

**193 browser checks passed, 0 failed, 0 console errors, 0 page errors.**

Command:

```bash
BASE=http://127.0.0.1:5176 API_BASE=http://127.0.0.1:8791 \
  ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance node scripts/ui-acceptance.mjs
```

Full PASS/FAIL transcript: `evidence/task-loop/UI_ACCEPTANCE_2026-11-03.log`.

Final-iteration additions verified: country/province/city/district rows in the event detail,
clickable official website plus visible source/document URLs, official-website discovery for
events that had none (27/31 demo events), and the 27-column CSV export including province/district.

| Area | Checks | Result |
|---|---|---|
| Six-page navigation, Events landing page, default filters | 13 | PASS |
| Events: filters, cards, list/timeline, detail panel, CSV/JSON export, discover/enrich actions | 30 | PASS |
| Tasks: statistics, state/kind filters, detail log, cancel/retry, SSE live update | 14 | PASS |
| Sources: registry table, filters, enable toggle, run now, create validation, edit, delete | 16 | PASS |
| Settings: seven sections, OCR endpoints, MCP/skills/plugins/recipes management, raw MCP PUT | 30 | PASS |
| Agent: composer, seeded history, read-only transcript | 6 | PASS |
| Projects: dashboard → insights → progress → report with saved version | 13 | PASS |
| Bilingual switch (中文 ⇄ EN), persistence after reload | 8 | PASS |
| Role viewer: read-only across Events/Tasks/Sources/Settings/Agent | 26 | PASS |
| Role user: toggles and source run allowed, management blocked | 16 | PASS |
| Restore admin role | 2 | PASS |
| Mobile 390×844: six pages without horizontal overflow, drawer, event detail | 11 | PASS |
| Error budget: 0 console errors, 0 pageerrors | 2 | PASS |

## What was checked (highlights)

- **Events (home)**: default region `cn` and range `12m`; undated events stay visible with
  “Date to be confirmed” after the f2 fix; status/keyword/region filters; list ⇄ timeline;
  completeness/confidence/status badges; detail panel with 16 fields, official link, verified
  sources with timestamps, documents with availability badge, missing-data notes; CSV download
  (`domel-events.csv`) and JSON download (`domel-events.json`); Discover/Enrich queue a task and
  show a notice + link to Tasks.
- **Tasks**: five state counters, state/kind filters, detail panel with payload/result/log
  timeline and full task id, Cancel on a queued task, Retry on a cancelled task, and a task created
  through the API appearing in the open page over SSE without a reload.
- **Sources**: 30 seeded sources, region/type filters, enable toggle round-trip, Run now, add-source
  validation (HTTPS and interval ≥ 30 s), create → appears in the table → delete → disappears,
  edit priority modal.
- **Settings**: all seven sections (Role & access, Agent tools, Document parsing, MCP servers,
  Skills, Plugins, Recipes); OCR endpoints autofill; admin can toggle/add/remove MCP, toggle skills
  and plugins, approve/disable recipes, and save the raw MCP JSON (PUT); the same page in
  user/viewer states disables or hides the management actions.
- **Agent**: admin composer and suggestions; two seeded read-only history transcripts; viewer has
  no composer and can still open a transcript.
- **Projects**: existing research flow pages still work; report version renders with approved
  finding and limitations.
- **Roles**: the workspace role is switched through `PATCH /api/v1/agent/settings` and restored to
  admin at the end (file fallback is required by design after a demotion; the script writes only
  the temporary `agent-config.json`).
- **Mobile 390×844**: all six pages render without horizontal overflow; drawer opens/closes;
  event detail panel opens without overflow.

## Production mode

Built with `npm run build`; a second build with `VITE_BACKEND_URL=http://127.0.0.1:8792` was used
only for the browser end-to-end pass on port 8792, because the checked-in default build targets the
documented demo port 8788. The single process served the UI and API on 8792 with
`SERVE_STATIC=1 STATIC_DIR=/tmp/domel-prod-dist`.

| Check | Result |
|---|---|
| `/health` | 200 `{"status":"ok","architecture":"local-single-user"}` |
| `/` with same-origin `Origin` | 200 `text/html`, contains `id="root"` |
| `/assets/*.js` with same-origin `Origin` | 200 `text/javascript` (440 KB) |
| `/assets/*.css` with same-origin `Origin` | 200 `text/css` |
| `/events/deep/link` SPA fallback with same-origin `Origin` | 200 `text/html` (`id="root"`) |
| `/api/v1/workspace` with same-origin `Origin` | 200 JSON (2 projects) |
| `/api/v1/workspace` with `Origin: https://evil.test` | **403** `Frontend origin is not allowed` |
| `/api/v1/workspace` without `Origin` | 200 |
| Browser E2E on 8792 (production bundle) | Event calendar renders 9 cards, 6 nav pages, SPA fallback renders, 0 console/page errors |

Static files remain publicly readable regardless of `Origin` (the CORS gate applies to `/api/`);
cross-origin scripts can be loaded but their responses are not exposed to foreign JS because no
`Access-Control-Allow-Origin` is emitted. Full logs: `evidence/task-loop/PRODUCTION_HTTP_2026-11-03.log`
and `PRODUCTION_BROWSER_2026-11-03.log`.

## Defects found during acceptance (all fixed by the owner and retested)

| # | Defect | Area | Fix commit |
|---|---|---|---|
| 1 | CORS preflight only advertised `GET,POST,PATCH,OPTIONS`, so cross-origin dev UI could not DELETE sources/MCP/skills/plugins or PUT raw MCP JSON | server | `3b76419` |
| 2 | Production same-origin assets/`/`/SPA fallback returned 403 when the browser sent a same-origin `Origin` header (Vite `crossorigin`), blank page | server | `3b76419` |
| 3 | Default Events view showed 0 records because the server-side date range dropped `startDate=null` events | src (f2) | `3b76419` |
| 4 | Cancelling a running Playwright-fallback collection crashed the whole API process (unhandled `page.content()` rejection) | server | `5c1ae5e` |
| 5 | `PUT /api/v1/agent/mcp` never parsed its request body, so “Save raw JSON” always failed with 409 | server | `ff8ec2b` |

Regression coverage added: `collector-abort` tests for #4 and an API acceptance section that
cancels a running JS-shell collection and then asserts `/health` twice; `task-api`/`agent-api`
tests for #1/#5; `static.test.mjs` for #2; UI checks for #3 (undated events visible) and #5
(raw JSON PUT).

## Test data note (constructed vs. real)

- The event library in `/tmp/domel-acceptance` was produced by **one real
  `POST /api/v1/events/discover {region:"cn",limit:20}`** (DeepSeek search): task `ab56b869`,
  19 candidates, 11 created, 8 merged, 0 failures. Four real `event.enrich` runs then fetched the
  official sites (AWE/Building & Construction/CIIE/CRH); three returned dates/fields, all kept
  “previous edition” notes.
- To make filters/reporting deterministic the acceptance run applied the product’s own manual
  correction (`PATCH /api/v1/events/:id`) to three undated records:
  - Canton Fair (China Import and Export Fair) → 2027-02-10 … 2027-02-12, status verified
  - China International HVAC and Building Services Exhibition → 2027-04-14 … 2027-04-16
  - China International Industry Fair (CIIF) → 2027-06-09 … 2027-06-11
  and recorded one document + one acceptance note on AWE (exhibitor list PDF, `downloadable`).
  **These dates/notes are constructed for acceptance and are not real verification results.**
- Five China events intentionally stayed undated to prove the “Date to be confirmed” visibility.
- Agent history in the viewer checks comes from a two-session transcript fixture written by
  `scripts/acceptance-api.mjs --prepare` before the API starts (no model call was made for this;
  agent chat itself is covered by 403/400 API checks, not by a live model run).
- The repository `.local/` directory was never modified. All data lives under `/tmp/domel-acceptance`.

## Screenshots (`evidence/ui-acceptance/`)

| File | Content |
|---|---|
| `20-events-list.png` | Events home, default China/12m, undated cards visible |
| `21-events-timeline.png` | Timeline view grouped by month + “Date to be confirmed” group |
| `22-events-detail.png` | Event detail: fields, sources, documents, notes |
| `23-tasks-list.png` | Task queue with five counters and live pill |
| `24-tasks-detail.png` | Task detail: payload/result/log timeline |
| `25-sources-admin.png` | Source registry table (admin) |
| `26-settings-admin.png` | Settings, all seven sections (admin) |
| `27-agent-admin.png` | Agent page with composer and history |
| `28-projects-report.png` | Saved report version in the existing research flow |
| `29-zh-tasks.png` | Chinese UI (Tasks) |
| `30-viewer-events.png` | Viewer: Events details without write actions |
| `31-viewer-sources.png` | Viewer: read-only sources |
| `32-viewer-settings.png` | Viewer: settings read-only |
| `33-viewer-agent.png` | Viewer: agent history, no composer |
| `34-user-sources.png` | User: source toggles/run now, no management |
| `35-user-settings.png` | User: settings toggle-only |
| `36`–`41-mobile-*.png` | Six pages at 390×844 |
| `42-mobile-nav.png` | Mobile drawer navigation |
| `43-mobile-event-detail.png` | Mobile event detail |
| `44-production-home.png` | Production bundle served by the API on 8792 |
| `45-production-spa-fallback.png` | Production SPA fallback |

Older `01`–`12` screenshots are kept for history.

## Reproduce

```bash
# 1. isolated data dir + seeded transcripts / source registry
rm -rf /tmp/domel-acceptance && node scripts/acceptance-api.mjs --prepare

# 2. frozen-code API
LOCAL_DATA_FILE=/tmp/domel-acceptance/domel.json LOCAL_DATA_DIR=/tmp/domel-acceptance \
AGENT_DATA_DIR=/tmp/domel-acceptance AGENT_TRANSCRIPT_FILE=/tmp/domel-acceptance/agent/transcripts.json \
AGENT_WORKSPACE_ROOT=/tmp/domel-acceptance/workspaces ASSISTANT_SESSION_DIR=/tmp/domel-acceptance/assistant \
TASKS_FILE=/tmp/domel-acceptance/tasks.json EVENTS_FILE=/tmp/domel-acceptance/events.json \
SOURCES_FILE=/tmp/domel-acceptance/source-registry.json DOCUMENTS_FILE=/tmp/domel-acceptance/documents.json \
RECIPES_FILE=/tmp/domel-acceptance/recipes.json LOCAL_API_PORT=8791 LOCAL_API_BIND=127.0.0.1 \
APP_ORIGINS=http://127.0.0.1:5176,http://127.0.0.1:5174,http://127.0.0.1:5175 \
SOURCE_SCHEDULER_MS=3600000 SERVE_STATIC=0 \
node --env-file-if-exists=.env --env-file-if-exists=.env.host server/local-api.mjs

# 3. one real discovery + enrich (needs DEEPSEEK_API_KEY in .env.host)
curl -X POST http://127.0.0.1:8791/api/v1/events/discover -H 'Content-Type: application/json' -d '{"region":"cn","limit":20}'
# wait for the task, then POST /api/v1/events/:id/enrich for events with a website

# 4. Vite dev server
VITE_BACKEND_URL=http://127.0.0.1:8791 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5176

# 5. browser + API acceptance
BASE=http://127.0.0.1:5176 API_BASE=http://127.0.0.1:8791 ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance \
  node scripts/ui-acceptance.mjs
API_BASE=http://127.0.0.1:8791 ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance node scripts/acceptance-api.mjs

# 6. production mode
npm run build
LOCAL_API_PORT=8792 SERVE_STATIC=1 STATIC_DIR=dist ... node server/local-api.mjs
```

If a run is interrupted while the role is not admin, restore it with
`AGENT_DATA_DIR=/tmp/domel-acceptance node scripts/agent-admin.mjs role admin`
(the script also restores admin in its `finally` block).

## Limits

- One browser engine (system Chrome) and two viewports; no Firefox/Safari or screen-reader pass.
- The demo has no authentication; role checks are functional only (documented deployment boundary).
- Production browser pass used a build bound to port 8792; the checked-in default build targets the
  documented demo port 8788, which is served by the Lead's demo process during this cycle.
- Network was used only for data preparation (one discovery run + four enrichments); assertions do
  not depend on external site content.
- `scripts/ui-acceptance.mjs` and `scripts/acceptance-api.mjs` are not part of `npm test`; they need
  a running demo and Chrome.

## Final iteration re-run (geo + official website enrichment)

After the acceptance cycle above, user review found that several events showed an empty
country and no official website, and that source URLs were only link targets, not visible text.
Changes (see git log): stored geography table `seed/geo-cn.json` + `server/geo.mjs` for
country/province/city/district, official-website discovery during enrichment (web search →
fetch → match → prefer the site root, never a contact page), source/document URL text in the
detail panel, and `scripts/backfill-event-geo.mjs` for old records.

Re-run results on the same frozen scripts (data isolated in `/tmp/lead-final2`):

| Check | Result |
|---|---|
| Browser acceptance `scripts/ui-acceptance.mjs` | **193 PASS / 0 FAIL**, 0 console/page errors |
| API acceptance `scripts/acceptance-api.mjs` | **179 PASS / 0 FAIL** (province/district CSV + AI model masking/capabilities checks) |
| Production HTTP (`SERVE_STATIC=1`, same-origin Origin) | `/`, `/assets/*.js|css`, SPA fallback, `/api/v1/workspace` 200; evil Origin 403 |
| Production browser E2E | Event calendar renders, SPA fallback renders, 0 console/page errors |
| `npm test` | **239/239** |

The final-iteration logs overwrite the same evidence files
(`evidence/task-loop/UI_ACCEPTANCE_2026-11-03.log`, `API_ACCEPTANCE_2026-11-03.log`,
`PRODUCTION_HTTP_2026-11-03.log`, `PRODUCTION_BROWSER_2026-11-03.log`).

## AI model settings (last UI iteration)

The Settings page gained an **AI model** section (admin): API key (write-only), model name and
base URL, so a DeepSeek key can be entered from the browser and a locally deployed
OpenAI-compatible model (Ollama/vLLM/LM Studio/internal gateway) can be used instead. The
acceptance re-run covers: the section is present for admin and viewer, the active
environment-configured model is shown without exposing the key, the key input is never
prefilled, and viewer controls are disabled. Counts above (193 browser / 179 API) are from
that re-run; `tests/llm-settings.test.mjs` covers the server side.
