---
name: Evidence quality
description: Rules for turning fetched pages into reviewable findings without inventing facts.
---
# Evidence quality

A finding is reviewable only when it is supported by a quote that exists verbatim in a source
you actually fetched.

Rules:
1. Every finding must carry `source_url` + `source_title` + `quote` (30–1200 characters, copied
   exactly from the fetched text; no paraphrasing inside quote).
2. `competitor`, `field` and `text` describe what the quote supports; never add numbers,
   market shares, dates or booth prices that are not in the quote.
3. Quote text and the source text you save must match after whitespace normalisation. If the
   system cannot find the quote in the source, the finding is dropped — do not work around that.
4. Separate confirmed facts from unconfirmed ones; keep Chinese "待确认" notes out of `text`.
5. Do not approve findings yourself: the review UI is where a human accepts/rejects them.
6. If sources are insufficient, write fewer findings and list the gaps; an honest partial result
   is better than invented coverage.
