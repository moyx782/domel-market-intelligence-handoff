# Real host execution verification �� 2026-10-27

No keys or credential values are included in this record.

## Configuration / connectivity
All four required host settings were present. Read-only checks eventually passed: API health 200; anonymous workspace request 401; cloud Auth public configuration 200; service-role queue-table read 200. DeepSeek authenticated GET /models returned 200, validating the supplied provider key. Earlier transient connection timeouts were retained in readiness records.

## Actual executions
1. Host acceptance 2026-10-27 (b10474ce-a93e-4bb2-ae92-a56fa8599618): host claimed and finished the real job, but the original 12-second DeepSeek Fetch request timed out. No sources/findings were invented or inserted. Result: failed.
2. Host saved-source acceptance 2026-10-27 (a8d76db6-912e-4917-b8db-8ff1551e9c47): copied the previously saved real source excerpt into a separate acceptance project while preserving its original retrieval timestamp (2026-10-20). Host Worker made a real paid extraction request, saved 1 pending candidate with an exact source quotation, and completed its job on attempt 1. Publication date remains unknown. The finding explicitly labels background information and requires market/quarter verification. This is not a fresh webpage retrieval.
3. Host retrieval retry 2026-10-27 (2d5a9ece-4079-47d0-b005-2ccfad0c55d3): host request timeout increased to 30 seconds. A fresh real page was fetched and stored. Model output failed strict evidence validation, so no candidates from this page were saved. Result: partial, with the failure visible in the project coverage log.

No team preset sources were chosen. All requests reused the URL already present in the user's earlier real source collection. Each run used one source. These were actual provider calls, not mock responses.

## Real candidate review/report rollback check
Using the validated candidate from execution 2, database verification temporarily accepted it, generated an approved-only report, edited the wording, confirmed approval reset to pending, and confirmed the old report snapshot did not change. The entire review/report transaction was rolled back. The real candidate remains pending; no simulated human approval or test report remains. Test projects were created/enqueued through the management SQL connection with existing owner identity for acceptance, not via a browser user session. This does NOT establish browser/API end-to-end acceptance or a real user review.

## Local verification
Typecheck, production build and all 34 tests passed after the timeout adjustment. Logs/source hashes: evidence/runs/2026-10-27T08-48-45-453Z/.
Host database calls now have a 15-second bound; host DeepSeek tool calls allow 30 seconds while legacy Edge defaults remain 12 seconds.

## Remaining acceptance
- In the signed-in frontend, open Host saved-source acceptance 2026-10-27, inspect Insights & evidence, source/date/context and pending finding; perform an actual user decision and refresh.
- Verify fresh retrieval -> validated candidate in one uninterrupted project, automatic discovery, then browser review/report and two-user isolation.
- URL scheduler, Python/Playwright, Pi Agent runtime and SSE remain separate planned integrations.
