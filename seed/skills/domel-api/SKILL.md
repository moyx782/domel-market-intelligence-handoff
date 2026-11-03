---
name: Domel API access
description: Call the local Domel market-intelligence API from the agent workspace with curl (events, sources, tasks, research).
---
# Domel API cheat sheet

The local API base URL is given in your task prompt (usually `http://127.0.0.1:8788`).
Use `bash` + `curl`; every response is JSON. No authentication on the trusted local demo.

```bash
API=http://127.0.0.1:8788

# workspace + projects
curl -s $API/api/v1/workspace
curl -s $API/api/v1/research-jobs

# event library
curl -s "$API/api/v1/events?region=cn&q=HVAC&limit=50"
curl -s $API/api/v1/events/<eventId>
curl -s -X POST $API/api/v1/events/<eventId>/enrich -H 'Content-Type: application/json' -d '{}'
curl -s -X POST $API/api/v1/events/discover -H 'Content-Type: application/json' -d '{"region":"cn","limit":20}'

# source registry
curl -s "$API/api/v1/sources?region=cn&enabled=true"
curl -s -X POST $API/api/v1/sources/<sourceId>/run -H 'Content-Type: application/json' -d '{}'

# tasks (poll progress / read logs)
curl -s "$API/api/v1/tasks?kind=event.enrich&limit=20"
curl -s $API/api/v1/tasks/<taskId>
curl -s -X POST $API/api/v1/tasks/<taskId>/cancel -H 'Content-Type: application/json' -d '{}'

# capabilities (AI / search / agent availability)
curl -s $API/api/v1/capabilities
```

Rules:
- Poll tasks until `state` is `succeeded`/`failed`/`cancelled`; the queue is single-worker, so a running enrich/discover task may take 10-60s.
- Do not fabricate API responses; if a call fails, report the HTTP status and error body.
- This API is for reading and queueing work; approvals stay in the review UI.
