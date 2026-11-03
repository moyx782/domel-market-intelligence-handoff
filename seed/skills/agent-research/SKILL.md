---
name: Agent-driven research
description: Research one project by collecting real pages and writing research-result.json for review.
---
# Agent-driven research

You are running a research job for one project. The goal is evidence, not prose.

Deliverable: write `research-result.json` in your current workspace with this exact shape:

```json
{
  "sources": [
    {"url": "https://public-page", "title": "Page title", "text": "the fetched readable text, at least the part containing quotes (max 24000 chars)"}
  ],
  "findings": [
    {"competitor": "one of the project competitors", "field": "one of the project focus fields",
     "text": "one-sentence finding", "quote": "exact quote from that source's text",
     "source_url": "https://public-page", "source_title": "Page title"}
  ]
}
```

Procedure:
1. Read the project scope/competitors/focus from the prompt or `GET /api/v1/workspace`.
2. Use the skills `domel-api`, `event-intelligence`, `source-collection` and `evidence-quality`.
   Prefer the API (events/source collection/tasks) for discovery and verification.
3. Fetch at most 5 public pages. Save the readable text for each source you cite.
4. Write 0–15 findings. Every finding needs an exact quote from the matching source text.
   Empty findings are acceptable if the evidence is insufficient; explain gaps in the final text.
5. Finish by writing `research-result.json` with the file tool (or output the same JSON in your
   final answer if the file tool is unavailable). The server imports and validates it, then a
   human reviews the findings.
