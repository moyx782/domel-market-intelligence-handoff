# UI acceptance — single-user demo

Date: 2026-11-03 (Asia/Tokyo)
Browser: Google Chrome 156.0.8078.79, Playwright 1.49.1, 1440×1000 and 390×844
Target: `http://192.168.1.10:5174` (LAN) with the local API on `http://192.168.1.10:8788`
Data: `.local/domel.json`, one real DeepSeek research run (`Live check · EC motors Q3`)

## Result

49 checks passed, 0 failed, 0 console or page errors.

| Area | Checks |
|---|---|
| Dashboard | LAN load, LOCAL DEMO badge, project row, approved/report counters |
| Project navigation | completes to Insights, accepted badge, 1 / 1 accepted |
| Review filters | All / Accepted / Rejected counts and empty states |
| Evidence review | quote block, public source link, disabled Save, Accept action |
| Progress | source count, host queue, assistant panel |
| Assistant (SSE) | real answer streamed, tool-backed citation, streaming state clears |
| Report | version selector, document, approved finding, limitations |
| Language | 中文 switch without reload, Chinese nav labels and document title, choice persists after reload, switch back to EN |
| Localized notices | stored coverage notices and report limitations render in Chinese, then English again |
| Mobile 390×844 | dashboard, status column visible, drawer open, close button, backdrop |
| Settings | role selector, agent tools section, OCR section, official/local API endpoint autofill |

Screenshots: `01-dashboard.png`, `01b-dashboard-zh.png` … `08-mobile-nav.png`, `09-settings.png`, plus Chinese `09-zh-insights.png`, `10-zh-evidence.png`, `11-zh-report.png`, `12-zh-mobile.png`, and localized-notice shots `04b-progress-zh.png`, `06b-report-zh.png` in this directory.

## Defects found and fixed during acceptance

1. **Corrupted glyphs.** `src/App.tsx`, `src/HostQueue.tsx` and `src/DataSources.tsx` contained 80 U+FFFD replacement characters (`·`, `…`, `—`, `←`, `–`), rendered as diamonds/boxes. All replaced with the intended characters.
2. **Favicon 404.** Every load logged `Failed to load resource: 404`. Added `public/favicon.svg` and a `<link rel="icon">`.
3. **Mobile project table hid status.** Competitors and Updated columns pushed Status off-screen at 390 px. The compact table now keeps Project / Status / open, and hides Competitors / Updated.
4. **Mobile drawer had no close.** Added an explicit Close button and a dimmed backdrop; both dismiss the drawer.
5. **Assistant did not know the project.** Tools previously required a `projectId` the model never received, so project questions answered "share the project id". Tools are now bound to the current project; verified with a real LAN question that called `list_findings`.

## Internationalization

- English (`en`) and Simplified Chinese (`zh`) share one dictionary keyed by the English source string; missing entries fall back to English instead of showing a raw key.
- `src/i18n.tsx` provides the provider, `useI18n()` and `Intl` locale selection. The switch lives in the header and on the login page, updates the whole tree in place (no reload), sets `<html lang>` and the document title, and persists to `localStorage` under `domel.lang`.
- First visit follows the browser language (`zh-*` → Chinese, otherwise English).
- Project data, user-entered competitors/focus areas and source quotations stay as entered. Server-generated coverage notices are translated at render time (`src/notices.ts`), so historical projects also follow the current language.
- The notice translator covers the workflow, DeepSeek search/fetch and extraction messages; an unknown future message falls back to English.
- The 中文/EN switch is covered by the browser acceptance run below.

## Limits

- Single browser (Chrome) and one viewport pair; no Firefox/Safari or screen-reader pass.
- Chinese coverage is verified for the main flows; the login screen is not reachable in the local demo, so its Chinese copy is build-checked only.
- The demo has no authentication and no per-user isolation; see README.
- No rate limit or cost ceiling on assistant or research calls.
- The UI test requires a running demo and Chrome; it is not part of `npm test`.

## Reproduce

```bash
npm run demo:lan
BASE=http://192.168.1.10:5174 npm run test:ui
```
