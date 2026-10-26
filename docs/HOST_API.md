# Host API contract v1 �� compatibility slice
Authentication: Authorization: Bearer <Supabase session access token>. API validates via getUser. Owner identity is server-derived. User-scoped database operations retain RLS. No service key is accepted from the client. JSON request maximum: 64 KB. Exact CORS origins configured through APP_ORIGINS. No silent legacy fallback.

| Method | Path | Body / response |
|---|---|---|
| GET | /health | Public process health only; not database/provider readiness |
| GET | /api/v1/capabilities | Authenticated configuration summary; no provider call or secret values |
| GET | /api/v1/workspace | Existing projects/sources/findings/audits/reports bundle filtered by user RLS |
| POST | /api/v1/research-tasks | Existing scope fields; returns Project. Ignores supplied owner/status/IDs |
| POST | /api/v1/research-tasks/{id}/run | mode: collect/research/extract; environment selected by host; returns durable job (202) |
| GET | /api/v1/research-jobs | Last 100 user-visible jobs in host environment; no lease token |
| PATCH | /api/v1/insights/{id}/review | text, decision, revision; existing optimistic-concurrency review RPC |
| POST | /api/v1/reports | project_id; immutable approved-only report snapshot |

Job states: queued -> running -> succeeded/failed. Expired running jobs can be reclaimed with a new token; third expired attempt becomes failed. Job success means orchestration finished, not all research evidence is complete. Project status/errors carry coverage and provider failures. Requests with existing active project+mode+environment coalesce; conflicting modes/environments reject. Saved-source extraction is allowed only for finished projects with stored sources and no findings.

Queue RPC permissions: enqueue_research requires the authenticated owner; claim_research, heartbeat_research and finish_research are worker service-role only. Result commit validates exact quotations and competitor/focus membership, and is one transaction. Duplicate finalization with the same lease returns success without duplicate writes; an obsolete lease cannot commit.

Errors: {error:string}. Invalid session 401; forbidden origin 403; malformed JSON/scope/mode 400; oversized body 413; business/configuration conflict 409; unknown route 404. Database/provider raw errors are not returned. Timestamps are ISO/UTC. This compatibility API does not yet implement full proposal resource pagination, SSE or the Source Registry contracts.
