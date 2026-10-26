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

## Run
Use Node 24, npm.cmd ci, then follow [HOST_SETUP.md](HOST_SETUP.md). Keep frontend public configuration in .env and server secrets in ignored .env.host. Configure the existing cloud project's additive migrations before starting the worker. Run host:api, host:worker and dev in separate terminals.

For classmates, VITE_BACKEND_URL must refer to the reachable team host; localhost refers to their own machine. Demo fixtures remain available without a real research run. Production/public deployment is not performed by committing this repository.

## Validation and limits
34 automated tests, typecheck and production build passed locally. Raw logs and source hashes: evidence/runs/2026-10-26T06-53-09-270Z/. This does not establish hosted migration, real provider billing, browser QA or real user acceptance.

This migration slice queues whole research runs. URL-level cooldown/domain scheduling, periodic source registry, Python/Playwright crawler, Pi Agent runtime and SSE replay remain planned integrations, not completed features. The current worker uses existing DeepSeek Search/Fetch/extraction. Preset data sources remain undecided. Existing sources represent collected excerpts, not the future source registry.

See [team workflow](CONTRIBUTING.md), [host API contract](docs/HOST_API.md), [setup](HOST_SETUP.md), and older [Week 6 acceptance](WEEK6_ACCEPTANCE.md). Host setup supersedes older Edge Function deployment instructions for host mode. Legacy Edge execution is available only through explicit VITE_EXECUTION_MODE=legacy-edge rollback.

Never commit API keys, service keys, passwords, .env/.env.host, node_modules, or private evidence. AI-assisted implementation and its validation limits must be disclosed accurately in course submissions.
