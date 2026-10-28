# Source collection correction — 2026-10-28

Baseline: GitHub main 9808e3675b3fffb23cb40abb1d1f6e90ff3ea452.

## Corrected behavior

- No default sources selected; SOURCE_DEFAULT_URLS defaults to an empty array.
- Removed the implicit www.ebmpapst.com restriction from both host and legacy Edge paths.
- Retired SOURCE_ALLOWED_DOMAINS, including pre-existing single-domain values; optional
  SOURCE_RESTRICT_DOMAINS is an explicit separate administrator restriction.
- Automatic search runs alongside manual and future default URLs.
- URLs are deduplicated; collection rotates between input pools and domains within
  each pool, so a long manual/default list cannot exclude all discovered pages.
- Search failures leave coverage notices and still allow supplied/default retrieval.
- Saved-source extraction remains network-free; existing evidence is not rewritten.
- The sources page reads actual backend defaults and explains additive discovery.

## Verification performed in this change

- npm test: 43 passed, 0 failed (including PostgreSQL queue and review tests).
- npm run build: passed (TypeScript and Vite production build).
- Both legacy function files passed TypeScript syntax transformation; dashboard
  bundle regenerated from the original modules.
- Test cases cover multiple public domains, empty defaults, ignoring the legacy
  single-domain setting, explicit admin restriction, discovery with manual URLs,
  future defaults plus search, cap fairness, duplicate URL fragments, search errors,
  unsafe URLs and saved-source extraction without new network access.
- Raw outputs: source-collection-2026-10-28/tests.log and build.log.

Provider responses were injected in tests. No live paid DeepSeek call, real
browser research run, or restart of the user's Windows host was performed in
this environment. Do not describe these tests as live collection acceptance.

The 2026-10-27 live execution record describes historical runs under the old
policy and is intentionally unchanged. Pull this code and restart the API/Worker,
refresh the frontend, then create a fresh research project for live acceptance.
No database migration or new secret is required.
