# Host + cloud Supabase setup

Architecture: application execution on team host; database and authentication on cloud Supabase. See docs/ADR-001-host-cloud.md.

## Single-user demo first
The current demo stage does not need this host configuration. Put `DEEPSEEK_API_KEY=...` in `.env.host` and run `npm run demo:api` plus `npm run dev`; data stays in `.local/domel.json` and there is no login. Continue below only when moving to multi-user host mode.

## Existing project deployment
1. Preserve the current project and data. Apply only new migrations not already applied, in order: 202610250001_review_evidence_guard.sql, then 202610260001_host_queue.sql. Never repeat the initial schema migration on an existing project. Back up before shared schema changes.
2. Copy .env.host.example to .env.host locally. Configure Supabase URL, publishable key, service-role key and DeepSeek key on the host. Do not put service-role/DeepSeek keys in VITE variables or commit .env.host. This execution environment did not have host service credentials and did not apply cloud migrations.
3. API and worker must use the same QUEUE_ENV. Use distinct development and demo environment names. Different members should not run workers in the same shared environment without explicit coordination.
4. Run npm.cmd run host:api in one terminal and npm.cmd run host:worker in another. Node 24 is the verified runtime. The API also loads the existing frontend .env for public Supabase settings. Worker credentials are loaded only from .env.host. The optional read-only assistant reuses DEEPSEEK_API_KEY; set ASSISTANT_ENABLED=0 to leave it off. Its JSONL sessions live in .pi-sessions/ and are not covered by Supabase backups.
5. Frontend: VITE_EXECUTION_MODE=host (default), VITE_BACKEND_URL=http://127.0.0.1:8787. Run npm.cmd run dev. Local API binds to loopback by default. For classmates on other computers, configure a reachable HTTPS host/reverse proxy and exact APP_ORIGINS, then set their frontend backend URL. Their localhost does not point to the team host. Never expose the service key or an unauthenticated worker port.
6. Legacy Edge Functions remain for explicit rollback using VITE_EXECUTION_MODE=legacy-edge; host mode never silently falls back to Edge Functions. New host worker does not require Edge Function deployment. Stop workers and let active jobs settle before rolling back.

## Live acceptance
- Sign in, open workspace, create project through API; owner is taken from verified identity, not request body.
- Start collection/research; inspect host queue panel and confirm queued -> running -> succeeded/failed. The research result can remain partial with honest coverage notices.
- Repeat submission while active: one job only. Another QUEUE_ENV must not claim it.
- Stop a running worker; after its 180-second lease expires, restart. Verify retry/new lease and no duplicate committed sources/findings. Provider requests may repeat if interrupted before commit.
- A second account must not read/review/generate reports for the first account's project.
- Review a real candidate, refresh, inspect history, export evidence and generate an approved-only report.
- Keep logs free of tokens/keys. Retain redacted screenshots and review/report JSON. Automated local tests are not hosted acceptance.

## Current limits
This first slice schedules entire research runs. It does not claim per-URL 30-second/domain throttling, periodic source scheduling, live Pi Agent, Python/Playwright crawling, SSE replay, source registry, or full production pagination. No team presets were selected. Public HTTPS collection is enabled by default; manual URLs and future team defaults supplement automatic search. SOURCE_ALLOWED_DOMAINS is retired; SOURCE_RESTRICT_DOMAINS is an optional explicit administrator restriction. Worker uses existing DeepSeek Search/Fetch and bounded extraction. Results are committed atomically after processing rather than checkpointed per page. The API returns generic configuration errors instead of raw provider/database errors. Host availability/network and cloud backup/export remain operational responsibilities.

## Read-only readiness check
Run npm.cmd run host:doctor after configuring .env.host. It records only configuration booleans, endpoint status codes and connection failures in evidence/host-readiness. It does not print keys, claim jobs, call the paid model, or apply migrations. Authentication/public configuration and a queue-table read are probed when their credentials are available. This is a readiness check, not full research acceptance.

## Network timeouts
Host Worker cloud database requests have a 15-second timeout so an unreachable cloud connection cannot stall a polling loop indefinitely. Host DeepSeek Search/Fetch requests allow 30 seconds; legacy Edge Functions retain the original 12-second default. The overall research budget and five-source cap still apply. Timeout failures remain visible as incomplete/failed research rather than fabricated evidence.


## Additive source collection (2026-10-28)
See [SOURCE_COLLECTION.md](docs/SOURCE_COLLECTION.md). Pull the new code and restart both API and Worker; refresh the frontend. Existing completed runs are historical records and are not rewritten. Start a new project to verify fresh discovery. No database migration or new secret is required.
