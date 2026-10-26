# ADR 001 �� Application host + cloud Supabase
Accepted: 2026-10-26, per project owner's instruction.

The application API, future Agent runtime, scheduler and crawler workers execute on the team host. Cloud Supabase retains PostgreSQL and authentication. This supersedes the strict all-components-on-one-host deployment boundary in proposal v0.1. Existing IDs, evidence, review history and report snapshots remain valid.

Frontend authentication continues through Supabase Auth. Business reads/writes use the host API by default. The API verifies each bearer token with getUser and creates a per-request client using the public key plus the user's token. It does not use a service key. Existing RLS and user-scoped RPC ownership checks apply. Only the worker has the service key; its claim/heartbeat/finalization RPCs are revoked from ordinary users.

First migration slice: durable research-level jobs and host execution using the existing DeepSeek adapter. This is not yet the full URL-level crawl scheduler, Source Registry, Python crawler or Pi Agent described in the proposal. Queue and research lifecycles are separated; successful job processing may still yield partial research coverage.

Jobs are separated by QUEUE_ENV. Each environment should have one deliberately managed API/worker pair. A project cannot be active in two environments. Row locking and lease tokens fence old workers; all result writes and completion commit in one transaction. Repeating the same finalization is idempotent. Expired work can be retried up to three attempts. Provider requests can repeat after a crash before result commit; exactly-once external billing is not promised.

Existing projects/sources/findings form a compatibility layer. Do not rename or overwrite sources as the future registry: it currently holds collected text. Future registry, content versions, evidence IDs and task/crawl subscriptions require additive contracts and migrations coordinated with the database and source owners.

Next integration stages: freeze Source/Content/Evidence contracts; URL-level scheduling with 30-second actual-start and domain limits; Python HTTP/Playwright adapter; Pi Agent tools and SSE event history; hosted end-to-end/user tests. Team presets remain empty until the team selects them.
