# Acceptance data preparation — 2026-11-03

Everything below lives in the isolated `/tmp/domel-acceptance` directory. The repository `.local/`
was never written by the acceptance run (only copied from, once).

## 1. Base data (`node scripts/acceptance-api.mjs --prepare`)

- `domel.json` copied from the repository demo data (2 research projects, incl. `Live check ·
  EC motors Q3` with 1 accepted finding and 1 saved report).
- `source-registry.json` imported from `seed/sources-cn.json` (30 sources) and every `nextRunAt`
  set to +24 h so the scheduler would not flood the single-worker queue during acceptance.
- `agent/transcripts.json` fixture with two read-only sessions for the viewer Agent checks
  (no model call was involved).
- No fallback event fixtures were used: the real discovery path below succeeded.

## 2. Real event discovery (one run, DeepSeek search)

`POST /api/v1/events/discover {"region":"cn","limit":20}` — task `ab56b869-f8cf-4fac-8b99-c421e7c6e87e`:

- state `succeeded`
- candidates 19, created 11, merged 8, skipped 0
- queries: three China trade-show queries derived from the built-in Domel company profile
- 11 China events persisted in `events.json`

Full task result: `evidence/task-loop/EVENT_DATA_PREPARATION_2026-11-03.json`.

## 3. Real enrichment (four runs)

`POST /api/v1/events/:id/enrich` for the four discovered records that had an official website.
All tasks succeeded and fetched the official site (HTTP collector); summary:

| Event | Fields found | Notes |
|---|---|---|
| Appliance & Electronics World Expo (AWE) | — | previous edition 2026-10-23, missing end date / deadline |
| China International Building & Construction Trade Fair | — | previous edition 2026-10-28, missing end date / deadline |
| China International Import Expo (CIIE) | startDate, endDate, country, organizer, documents, exhibitorListUrl | city/venue multi-source mismatch, missing deadline |
| China Refrigeration (CRH) | — | dates not found, notes added |

These are real network results; three events kept the “previous edition” caveat in `notes`.

## 4. Constructed (non-real) manual corrections for deterministic UI checks

The product’s manual-correction path (`PATCH /api/v1/events/:id`) was used on three undated records.
**These dates are acceptance data, not verified real event dates:**

| Event | startDate | endDate | status |
|---|---|---|---|
| Canton Fair (China Import and Export Fair) | 2027-02-10 | 2027-02-12 | verified, confidence medium |
| China International HVAC and Building Services Exhibition | 2027-04-14 | 2027-04-16 | discovered |
| China International Industry Fair (CIIF) | 2027-06-09 | 2027-06-11 | discovered |

Also recorded on AWE through `PATCH`: one document
`https://www.awe.com.cn/exhibitor-list.pdf` (`downloadable`, type pdf) and one acceptance note.
The remaining China events intentionally stayed `startDate: null` to verify “Date to be confirmed”
visibility in the default 12-month view.

## 5. Final visible dataset

- 11 China events; 3 real enriched records (past dates / previous edition), 5 undated records, and
  the 3 constructed dates above.
- Default China + next-12-months view: **9 visible** (5 undated + 4 dated in window), 6-month view:
  8, Europe: 0 (empty state), status split: enriched 1 / verified 1 / discovered 7.
- Agent history: 2 read-only seeded sessions.
- Sources: 30; MCP/skill/plugin/recipe rows created by the acceptance script in the isolated agent
  config (not the repository `.local/`).

After the final round the role is restored to `admin`; if a run is interrupted, restore with:

```bash
AGENT_DATA_DIR=/tmp/domel-acceptance node scripts/agent-admin.mjs role admin
```
