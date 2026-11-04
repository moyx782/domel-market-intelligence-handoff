# Agent runtime: MCP, skills, plugins, roles and run history

The local demo runs a Pi coding agent that can use MCP servers, skills, plugins and a
local workspace. Everything lives under `.local/agent/` so it can be inspected, copied
or versioned.

```
.local/
  agent-config.json            role, CLI switches, OCR settings, skill/plugin metadata (0600)
  agent/
    mcp.json                   MCP server config, standard mcpServers shape (0600)
    skills/<slug>/SKILL.md     one directory per skill
    extensions/<slug>/         Pi extensions (plugins)
    sessions/<project>/        Pi session files
    transcripts.json           durable run history shown by the Agent page
    mcp.log                    MCP connection log
  workspaces/<project|general>/  agent working directory
```

## AI model settings (deepseek or a local model)

Admin → Settings → **AI model** configures the model used by the research
assistant, the Agent page and extraction:

| Field | Meaning |
|---|---|
| Model name | e.g. `deepseek-flash`, or the model id served by your local server (`qwen2.5`, `llama3.1` …) |
| Base URL | blank/`https://api.deepseek.com` = DeepSeek official; anything else is treated as an OpenAI-compatible endpoint (`http://127.0.0.1:11434/v1`, `http://vllm.internal:8000/v1`, …) |
| API key | write-only: stored in `.local/agent-config.json` (0600), never returned by the API; leave blank to keep, clear to fall back to `.env.host` |

Priority: Settings value > `.env.host` environment. Saving rebuilds the model
runtime lazily, so the key works without restarting the process. A custom Base
URL switches the assistant/agent/extraction to that local model; because local
models have no DeepSeek search/fetch tools, discovery falls back to the source
registry scan and enrichment skips the official-website web search. Set
`CUSTOM_AI_CONTEXT_WINDOW` / `CUSTOM_AI_MAX_TOKENS` in the environment when the
local model needs a larger context.

```bash
# example: Ollama serving an OpenAI-compatible API
curl -s http://127.0.0.1:8788/api/v1/agent/settings   -H 'Content-Type: application/json'   -d '{"llm":{"baseUrl":"http://127.0.0.1:11434/v1","model":"qwen2.5","apiKey":""}}'
```

## Roles (four tiers)

`viewer(0) < user(1) < admin(2) < system(3)`. `system` (T0) can only be set from the local
CLI (`node scripts/agent-admin.mjs role system`); the web UI never offers it and an admin
cannot grant it. If a web downgrade locks the demo, restore admin from the CLI:

```bash
node scripts/agent-admin.mjs role admin
```

| Action | system | admin | user | viewer |
|---|---|---|---|---|
| Read events/projects/evidence/reports and Agent history | yes | yes | yes | yes |
| Create tasks (discover/enrich/collect/research), correct events | yes | yes | yes | no |
| Review findings, generate reports | yes | yes | yes | no |
| Agent chat | yes | yes | yes | no (read-only history) |
| Toggle MCP/skills/plugins/sources | yes | yes | yes | no |
| Add/edit/delete MCP/skills/plugins/sources/recipes | yes | yes | no | no |
| Change role (admin/user/viewer) | yes | yes | no | no |
| File tools / shell switches | yes | no | no | no |

API writes call `can(role, action)` and return `403 {error, requiredRole}` when the role is
too low. The matrix is enforced in `server/permissions.mjs` and covered by
`tests/permissions.test.mjs` and the API tests.

## MCP

**`agent/mcp.json` is the source of truth.** Edit it by hand, through the API, or through
Settings → MCP servers; the runtime reads the file on every run and passes it to Pi's MCP
extension, so tools appear as `mcp__<server>__<tool>`. The settings page can also replace
the whole file as raw JSON and test a connection (the test lists the tools the server
exposes).

```bash
curl -X POST http://127.0.0.1:8788/api/v1/agent/mcp/test \
  -H 'Content-Type: application/json' -d '{"name":"qichacha"}'
# => {"ok":true,"tools":[{"name":"..."}]}
```

stdio entries need absolute `command` paths: the child process inherits the agent's
workspace, not the repository root.

## Skills

A skill is a directory with `SKILL.md`:

```
---
name: 展会检索
description: Find upcoming HVAC trade shows
---
When asked about trade shows, search for upcoming exhibitions, list date, city,
venue and source URL, and separate confirmed dates from unannounced ones.
```

Skills are discovered from `agent/skills/*` even when copied in by hand. `enabled` is
stored in `agent-config.json`; only enabled directories are passed to the resource loader.
The settings page can create, edit, enable/disable and delete skills (admin).

## Plugins

A plugin is a Pi extension directory under `agent/extensions/<slug>/` with an entry file
(`index.js` by default). Admins install/uninstall and edit them from Settings → Plugins;
users may only toggle. A stdio MCP server or plugin executes arbitrary code — the admin
role is host-level trust.

## Agent tools

- Default: all built-in file tools (`read/write/edit/grep/find/ls`), `bash`, every
  enabled skill, plugin and MCP tool.
- `cli.enabled=false`: file tools and bash are removed; only MCP tools remain.
- `cli.allowBash=false`: file tools stay, `bash` is removed.
- Only `system` can change these switches; admin sees them read-only.

## Agent chat and history

`POST /api/v1/agent/chat` streams SSE:

```json
{"projectId":"general","message":"Check the latest trade shows"}
```

Events: `delta`, `tool_start` (tool name and truncated args), `tool_end`, `done` (text and
workspace path), `warning`, `error`. Project ids use `.local/workspaces/<id>`; `general` is
the shared workspace. The endpoint returns 503 when `DEEPSEEK_API_KEY` is missing and 403
for viewer.

Every completed run is appended to `.local/agent/transcripts.json` with the user prompt,
assistant answer and tool calls. The Agent page shows this history to every role:

```
GET /api/v1/agent/sessions?projectId=general   → {sessions:[{id,projectId,title,createdAt,updatedAt,messageCount}]}
GET /api/v1/agent/sessions/:id                 → {id,projectId,createdAt,updatedAt,messages:[{role,text,at,toolCalls?}]}
```

Viewers see history only (no composer); users/admins/system can chat and interrupt a run.
The Agent page is `src/Agent.tsx`.

## Verification

- `tests/agent-api.test.mjs`, `tests/agent-config.test.mjs`, `tests/agent-mcp.test.mjs`,
  `tests/agent-tools.test.mjs`, `tests/agent-sessions.test.mjs`: config, MCP end-to-end,
  tool switches, transcript store and read-only history.
- Real DeepSeek smoke test (2026-11-03): a configured stdio MCP server exposed
  `mcp__mock__echo`; the model called it with `{"text":"hello from mcp"}` and received
  `echo:hello from mcp`. The server was removed afterwards.
- Real Agent chat + transcript recorded through the local API (2026-11-03).

## Limits

- MCP connection failures only go to `agent/mcp.log`; the chat stream does not surface them.
- MCP tools are exposed `direct`; codemode/tool-search exposure is not in the UI yet.
- Transport security, login and storage encryption are out of scope for this repository.

## Shipped skills (seed/skills)

A fresh data directory auto-imports the five skills under `seed/skills/` into
`.local/agent/skills/`; Settings → Skills lists them and the Agent loads them
per session:

| Skill | What it teaches the agent |
|---|---|
| `domel-api` | curl recipes for the local API (events, sources, tasks, capabilities) |
| `event-intelligence` | discover → inspect → enrich workflow, official-website rules, previous-edition dates |
| `source-collection` | source registry, collector behaviour/errors, safe single-page fetch |
| `evidence-quality` | exact-quote rule, no invented numbers/dates, GIGO gaps, human review |
| `agent-research` | the `research-result.json` contract and research procedure |

They are instructions, not tools: the agent uses them with its `bash`/file
tools. If a data directory already has skills, the seed is not overwritten; copy
`seed/skills/*` into `.local/agent/skills/` manually for an existing deployment.

## Agent-driven research

Project page → **Agent research** (`POST /api/v1/research-tasks/:id/run` with
`{"mode":"agent"}`) queues a `project.agent-research` task. The agent receives
the project scope, the local API base URL, the workspace path and its skills; it
must collect real public pages and write `research-result.json`:

```json
{"sources":[{"url":"https://...","title":"...","text":"readable page text"}],
 "findings":[{"competitor":"...","field":"...","text":"...","quote":"exact quote",
              "source_url":"https://...","source_title":"..."}]}
```

The server validates the file before importing: sources must pass the public
HTTPS source policy, competitors must be in the project, fields must be in the
project focus, and every quote must appear verbatim in the saved source text
(whitespace-normalised). Invalid findings are dropped, the rest are stored as
sources + findings with `decision=pending` for human review. The final answer
JSON is accepted as a fallback when the model has no file tool.

Requirements/limits: a configured agent model with tool calling; `bash` and file
tools enabled in Agent tools (T0 defaults); 0–25 findings per run; if the agent
produces no usable source the task fails instead of writing invented evidence.
There is no automatic approval — findings still go through the review UI.

## OCR materials and agent reports

`event.agent-report` lets the agent turn OCR/parsed materials into a Chinese
Markdown report: it reads each material's full text, writes `event-report.json`
with `reportMarkdown` + per-material summaries/quotes + warnings, and the server
validates known URLs and verbatim quotes before writing `event.materialsReport`.
The UI (event detail → OCR materials) shows the summaries, material text and the
report; both document OCR and report generation are exposed as queue tasks.

## Adaptive fetch fallback

When normal collection gets no usable page, `event.enrich` can queue
`agent.fetch` (env `AGENT_FETCH_FALLBACK=0` disables it). The agent runs
`scripts/adaptive-fetch.mjs` with its bash/file permissions: HTTP → browser render
→ scroll/iframe text → screenshot OCR. It honours robots/login/paywall limits,
saves the result as an `agent-adaptive` material + candidate source, and queues
the material report. Manual API: `POST /api/v1/agent/fetch {url,eventId?}`.
