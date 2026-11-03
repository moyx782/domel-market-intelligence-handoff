---
name: Trade-show intelligence
description: Find Chinese trade shows, verify their official website/dates/venue, and summarize verifiable facts with sources.
---
# Trade-show intelligence

Use the event library instead of guessing. Workflow:

1. **Find candidates**
   `POST $API/api/v1/events/discover {"region":"cn","limit":30}` then poll `/api/v1/tasks/<id>`.
   The library dedupes by name/date/venue and by official website host.
2. **Check what is known**
   `GET $API/api/v1/events?region=cn&q=<keyword>`; read `name/startDate/city/venue/website/notes/confidence`.
   `notes` list missing fields and past-edition caveats — do not turn "待确认" into a fact.
3. **Verify an event**
   `POST $API/api/v1/events/<id>/enrich` (poll the task). Enrichment fetches official pages, prefers
   JSON-LD, probes documents (linked/downloadable/restricted/unknown), and writes Chinese notes.
4. **Official website rules**
   Only a fetched page whose title/JSON-LD matches the event may become `website`.
   Forums/news/directory pages (`/thread`, `/bbs`, `/news`, `/article`, `/contact`, aggregators)
   are rejected; if search results are only such pages the note says so. Never present a forum
   thread as the official site.
5. **Dates**
   Past dates mean "previous edition"; keep them but mark the next edition as unconfirmed.
   Today is available via `date +%F` in bash.

Useful fields: `country/province/city/district/venue` come from the stored geo table; missing
fields are real gaps, not something to invent.
