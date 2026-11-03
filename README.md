# Domel Market Intelligence

AI-assisted research with traceable public evidence, human review and approved-only reports.

## Current architecture �� 2026-10-26
Application execution moves to the team host; cloud Supabase retains database and authentication. This decision supersedes the strict single-host boundary of proposal v0.1. See [architecture decision](docs/ADR-001-host-cloud.md).

- React/TypeScript frontend and Supabase Auth remain.
- Business reads, project creation, research submission, evidence review and report generation go through the Node host API by default.
- Cloud PostgreSQL stores research jobs. Host worker claims an environment-specific job using a lease, executes the existing DeepSeek adapter and atomically commits sources/findings/result status.
- Per-request API clients use the verified user's token and public key. Only workers hold the service-role key.
- Queue UI shows actual job state, environment and attempt count.
- Existing source IDs, review history and immutable report snapshots remain intact.
- Experimental read-only research assistant: `POST /api/v1/research-tasks/{id}/assistant` streams project Q&A over SSE using the Pi coding-agent SDK, with Supabase reads only. Session files live in gitignored `.pi-sessions/`, not in Postgres.
- Agent runtime: MCP servers and skills live under `.local/agent/` (generated `mcp.json`, `skills/<slug>/SKILL.md`); admins manage them through the local API, viewers can only enable or disable. See [agent runtime](docs/AGENT_RUNTIME.md).
- Bilingual interface: the UI ships English and Simplified Chinese. The header `中文 / EN` switch changes every label instantly without a reload, defaults to Chinese on Chinese browsers, and remembers the choice in `localStorage` (`domel.lang`). Stored research coverage notices are translated at render time, so existing projects switch too.

## Single-user demo (default)
No Supabase project, login or service-role key is needed. The demo stores everything in `.local/domel.json` and runs research inside the local API process; multi-user accounts and RLS are a later stage.

The demo ships with a built-in Domel company profile (`seed/company-domel.json`, derived from domel.com) so no industry input is needed; every demo and test uses Domel as "our company".

1. Put the server-side DeepSeek key in `.env.host`: `DEEPSEEK_API_KEY=...`. Never use a `VITE_` prefix for it.
2. Run `npm run demo:api` (API on 127.0.0.1:8788) and `npm run dev` (frontend on 127.0.0.1:5174) in separate terminals.
3. Open http://127.0.0.1:5174, create research, run Collect + AI extract, review evidence, generate a report, and ask the read-only assistant.

Without the key the workspace still opens and review/report work, but research and the assistant return a configuration error. Stop the API and delete `.local/` to reset the demo data. Hosted multi-user mode below is unchanged and still requires the cloud setup.

### Share on the LAN
`npm run demo:lan` binds the API to 0.0.0.0:8788 and Vite to 0.0.0.0:5174, allows the detected LAN origins, and prints the addresses. A page opened through a LAN address calls the API on the same host automatically. The demo has no authentication: anyone on that network can read the data and spend the DeepSeek key. Use it only on a trusted network, make sure the host firewall allows 5174 and 8788, and stop it with Ctrl+C when finished.

## Run
Use Node 24, npm.cmd ci, then follow [HOST_SETUP.md](HOST_SETUP.md). Keep frontend public configuration in .env and server secrets in ignored .env.host. Configure the existing cloud project's additive migrations before starting the worker. Run host:api, host:worker and dev in separate terminals.

For classmates, VITE_BACKEND_URL must refer to the reachable team host; localhost refers to their own machine. Demo fixtures remain available without a real research run. Production/public deployment is not performed by committing this repository.

## Validation and limits
72 automated tests and a 49-check browser flow passed locally (evidence/ui-acceptance/UI_ACCEPTANCE.md), typecheck and production build passed. On 2026-11-03 one real DeepSeek research run (5 pages fetched, 1 finding, partial coverage) and one assistant answer were executed locally. Raw logs and hashes for the earlier host slice: evidence/runs/2026-10-26T06-53-09-270Z/. This does not establish hosted migration, real provider billing, multi-user acceptance or repeated-run stability.

The current demo queues whole research runs. The approved plan replaces that with a durable task loop and source registry, a Node HTTP crawler with Playwright fallback and agent-authored crawl recipes, agent-driven research, four-tier roles (system/admin/user/viewer), plugins, and task/agent/settings pages. Those are not implemented yet. The current worker uses existing DeepSeek Search/Fetch/extraction. Existing `sources` rows are collected excerpts, not the future source registry.

For deployment see [trusted-network deployment](docs/DEPLOYMENT.md). See the approved [implementation plan](docs/IMPLEMENTATION_PLAN.md) (task loop, source registry, Node crawler, four-tier roles, plugins, five frontend pages) and the [handoff document](docs/HANDOFF.md) for current state, commands and known pitfalls. Also: [team workflow](CONTRIBUTING.md), [agent runtime](docs/AGENT_RUNTIME.md), [document parsing](docs/DOCUMENT_PARSING.md), [host API contract](docs/HOST_API.md), [setup](HOST_SETUP.md), and older [Week 6 acceptance](WEEK6_ACCEPTANCE.md). Host setup supersedes older Edge Function deployment instructions for host mode. Legacy Edge execution is available only through explicit VITE_EXECUTION_MODE=legacy-edge rollback.

Never commit API keys, service keys, passwords, .env/.env.host, node_modules, or private evidence. AI-assisted implementation and its validation limits must be disclosed accurately in course submissions.
