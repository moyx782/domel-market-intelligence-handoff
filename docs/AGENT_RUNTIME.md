# Agent runtime: MCP and skills

The local demo now runs a Pi coding agent that can use MCP servers and skills. Everything lives under `.local/agent/` so it can be inspected, copied or versioned.

```
.local/
  agent-config.json            admin settings: role, CLI, MCP servers, skill metadata
  agent/
    mcp.json                   generated MCP config (mcpServers shape)
    skills/<slug>/SKILL.md     one directory per skill
    sessions/<project>/        Pi session files
    mcp.log                    MCP connection log
  workspaces/<project|general>/  agent working directory
```

## MCP

**`agent/mcp.json` is the source of truth.** Edit it by hand, through the API, or through the settings UI; the runtime reads the file on every run and passes it to Pi's MCP extension, so tools appear as `mcp__<server>__<tool>`.

An admin can write the whole file through the API when the server already exists elsewhere:

```bash
curl -X PUT http://127.0.0.1:8788/api/v1/agent/mcp \
  -H 'Content-Type: application/json' \
  -d '{"mcpServers":{"qichacha":{"command":"/usr/bin/npx","args":["-y","@vendor/qichacha-mcp"],"env":{"QCC_KEY":"..."},"exposure":"direct"}}}'
```

Probe a configured server before using it:

```bash
curl -X POST http://127.0.0.1:8788/api/v1/agent/mcp/test \
  -H 'Content-Type: application/json' -d '{"name":"qichacha"}'
# => {"ok":true,"tools":[{"name":"..."}]}
```

stdio:

```json
{
  "mcpServers": {
    "qichacha": {
      "command": "/usr/bin/npx",
      "args": ["-y", "@vendor/qichacha-mcp"],
      "env": {"QCC_KEY": "..."},
      "exposure": "direct"
    }
  }
}
```

HTTP:

```json
{
  "mcpServers": {
    "qichacha": {
      "url": "https://mcp.example.com/qcc",
      "headers": {"Authorization": "Bearer ..."},
      "exposure": "direct"
    }
  }
}
```

`exposure: "direct"` declares the tools to the model immediately. Absolute command paths are required when the server should start from any workspace: the child process inherits the agent's working directory, not the repository root.

Add one server without replacing the file (admin role):

```bash
curl -X POST http://127.0.0.1:8788/api/v1/agent/mcp \
  -H 'Content-Type: application/json' \
  -d '{"name":"qichacha","transport":"stdio","command":"/usr/bin/npx","args":["-y","@vendor/qichacha-mcp"],"env":{"QCC_KEY":"..."}}'
```

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

Skills are discovered from `agent/skills/*` even when copied in by hand. `enabled` is stored in `agent-config.json`; only enabled directories are passed to the resource loader. The agent sees the skill list and loads a skill before using it.

## Roles

`role` is `admin` (default) or `viewer`.

| Action | Admin | Viewer |
|---|---|---|
| Read config | yes | yes, secrets masked |
| Enable/disable MCP server or skill | yes | yes |
| Add, edit, delete MCP server or skill | yes | no (403) |
| Change role or CLI switches | yes | no (403) |
| Chat with the agent | yes | yes |

## CLI

`cli.enabled=false` removes file and shell tools; `cli.allowBash=false` keeps read/write/edit/grep/find/ls but removes `bash`. Both are admin-only.

## Agent chat

`POST /api/v1/agent/chat` streams SSE:

```json
{"projectId":"general","message":"Check the latest trade shows"}
```

Events: `delta`, `tool_start` (tool name and truncated args), `tool_end`, `done` (text and workspace path), `warning`, `error`. Project ids use `.local/workspaces/<id>`; `general` is the shared workspace. The endpoint returns 503 when `DEEPSEEK_API_KEY` is missing.

## Verification

- 72 automated tests, including an end-to-end MCP test that starts `tests/fixtures/mcp-echo-server.mjs`, runs one agent turn with a scripted model, and asserts `mcp__mock__echo` was called.
- Real DeepSeek smoke test on 2026-11-03: a configured stdio MCP server exposed `mcp__mock__echo`; the model called it with `{"text":"hello from mcp"}` and received `echo:hello from mcp`. The server was removed afterwards.
- Skills are discovered from `SKILL.md`; the test asserts the enabled path and the prompt includes the skill.

## Limits

- MCP connection failures are not yet surfaced in the chat stream; check `agent/mcp.log`.
- Any stdio MCP server runs arbitrary code. Only admins may add servers; treat the admin role as host-level trust.
- MCP tools are exposed `direct`; codemode and tool-search exposure are not exposed in the UI yet.
- The admin panel UI, the global Agent page and the agent-driven researcher are not built yet; this slice covers the storage, permissions, runtime and APIs.
