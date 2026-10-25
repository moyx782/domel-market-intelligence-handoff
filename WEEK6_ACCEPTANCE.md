# Week 6 implementation and acceptance �� 2026-10-25

## Current status
Week 6 is NOT yet accepted as complete. This record describes local implementation and local checks only. The private UNO Week 6 guide was not accessible in this execution environment; confirm its exact submission fields before submitting. The previously supplied PPT guide asks for working login, linked data tables, Feature 1 working with real records, and at least one working step of Feature 2.

## Implemented in this iteration
- Feature 1: DEEPSEEK_API_KEY now supports both existing Search/Fetch and model extraction when the user explicitly starts Collect + AI extract. Default extraction model is deepseek-flash; DEEPSEEK_MODEL can override it. Complete custom AI_BASE_URL / AI_API_KEY / AI_MODEL settings take precedence. Partial custom settings fail closed.
- Extraction validates requested competitor/custom focus and exact source quotation before saving pending findings. Invalid/truncated responses and provider failures cannot create findings. Successfully saved source text remains available when extraction fails.
- Authenticated backend readiness check reports configuration booleans, approved domains and five-source limit; it never returns secrets and does not itself test provider connectivity.
- Feature 2: original text, edits, decisions, reviewer, timestamps and audit history can be inspected and exported as JSON, with a copyable preview if downloading fails.
- New database migration blocks acceptance when the linked source cannot support the exact quotation. Editing accepted findings still resets them to pending; old reports remain immutable.
- Team preset data sources remain undecided and empty. No new data sources were selected.

## Local evidence
Run directory: evidence/runs/2026-10-25T13-23-01-721Z/
Typecheck PASS; production build PASS; automated tests PASS.
AI adapter tests use injected HTTP responses; database tests run embedded PostgreSQL. These are NOT real paid API or hosted Supabase tests. No new browser screenshots or cloud deployment are claimed.

## Deploy the existing Supabase project
Project: skjtqpuetfrzahrnbdyb. Do not recreate the project or re-run the initial database migration.
1. In Supabase SQL Editor, run only supabase/migrations/202610250001_review_evidence_guard.sql. This replaces the review function and does not delete records.
2. Edge Functions > Secrets: ensure DEEPSEEK_API_KEY is saved. Do not paste the key into chat, screenshots, GitHub, or VITE variables. If unused partial AI_* settings exist, remove them or supply the complete custom provider configuration. The DeepSeek fallback requires no AI_* settings.
3. Keep SOURCE_ALLOWED_DOMAINS at the team's actual approved policy. No team presets have been selected by this update. Additional domains need a team decision; missing domains mean limited coverage, not a successful full competitor comparison.
4. Open research > Code. Replace index.ts with the complete generated supabase/dashboard/index.ts and deploy. Keep explicit in-function JWT validation; verify gateway settings are compatible with the existing frontend session.
5. Open the local updated frontend, sign in, create a fresh project with an approved real source, and click Check backend readiness. It should return version week6-2026-10-25. This is configuration detection only.
6. Click Collect + AI extract. This performs paid provider calls. Wait for completion. If sources save but no supported findings are found, retain the honest partial/empty result; do not invent a finding to pass acceptance.

## Live acceptance and evidence to retain
- Login with an individual account; sign out and sign back in. New invited user sets their password and can enter. Save redacted screenshots without session tokens.
- Create a fresh scoped project; refresh and reopen the same record.
- Run real research. Retain scope, coverage log, source URL/text/retrieval time, candidate finding and exact supporting passage. Unknown publication dates remain unknown and require human review.
- Open a real candidate in Evidence review. Save an edit, refresh, confirm text and pending state. Accept it, refresh, confirm reviewer/time/revision and history persist. Export review JSON.
- Reject another candidate if available; verify it is excluded from a newly generated report. If only one candidate exists, accept/export, reject/generate-check, then accept again with its current revision and keep the audit trail.
- Generate a report from accepted content; retain report version and references. Pending/rejected content must not appear. Missing competitor evidence must be labelled insufficient evidence.
- Test a second account cannot access the first account's records. Embedded tests passing do not replace this hosted test.

## Kanban wording
Feature 1 �� In Progress: DeepSeek search/fetch/extraction implemented locally; pending cloud deployment and real end-to-end acceptance.
Feature 2 �� In Progress: review persistence code, audit/export, server evidence guard implemented; pending real candidate review/refresh verification.
Week 6 �� In Progress: local implementation and checks retained; live acceptance and exact UNO guide confirmation outstanding.

## Saved-source continuation update
- Added Extract from saved sources for finished projects with saved source text and no existing candidates. It calls the model but does not search, fetch pages or insert new sources.
- Original source IDs and retrieval timestamps are retained. Previous collection coverage notices remain in the log.
- Projects with existing findings cannot run this continuation, preventing duplicate findings and preserving review history.
- The server claims a run with both status and updated_at, preventing simultaneous requests from claiming the same project snapshot.
- Preferred source storage now tolerates malformed browser data, limits the list to 15 pages, and preserves the input when saving fails.
- Additional local verification: evidence/runs/2026-10-25T13-51-16-989Z/ �� typecheck/build PASS, 32/32 automated tests PASS. These checks do not establish hosted execution success.

After deploying the latest generated function, an existing collection-only project can use Extract from saved sources rather than creating a new project. Save the resulting review JSON after inspecting a real candidate. A failed/empty extraction remains a partial result; no synthetic candidates are added.
