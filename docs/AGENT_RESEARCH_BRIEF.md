# Agent-first research creation

New research now asks for two inputs: research direction (120 characters) and research questions/requirements (1500 characters). Submission saves a project and immediately starts the existing mode=agent task. The title is derived from the direction. If Agent startup fails, the draft remains accessible and can be retried from project progress.

The compatibility fields Research subject / Research findings are grouping labels for the existing review and report schema. They are not inferred competitors. The creation quarter is metadata, not a date filter for this free-form brief; the Agent prompt follows dates, companies and geography explicitly provided by the user. Existing structured projects retain their original scope behavior.

Sources and candidate findings still pass the existing Agent result validation. Human evidence review, edit/approval reset, rejection and approved-only report generation remain unchanged. Demo mode saves an illustrative draft and does not claim a real Agent run.

Validation on Windows, 2026-11-04:
- Production TypeScript/Vite build passed.
- 14 targeted tests passed: new brief validation and source-result compatibility; API creation with the brief and Agent task scheduling; existing Agent validation; i18n; approval/report rules.
- Headless Chrome interaction passed with intercepted APIs: two-field form -> saved project -> mode=agent -> review navigation. This was not a paid live Agent acceptance run.
- Full suite: 272 passed, 3 failed, 1 skipped. Failures were in unrelated OCR tests (missing zip executable, unavailable PDF fixture in the isolated checkout, and OCR configuration assertion). No full-suite pass is claimed.

This change targets the local Demo API, which implements Agent research. The historical Supabase host API does not implement mode=agent and has not been migrated by this change.
