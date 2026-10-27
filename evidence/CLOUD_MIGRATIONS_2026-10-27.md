# Cloud migration verification �� 2026-10-27

Project: domel-market-intelligence (skjtqpuetfrzahrnbdyb), ACTIVE_HEALTHY.
Existing schema was created manually; migration history was initially empty. The initial create-table migration was NOT replayed.

Applied through Supabase connection:
- 20261027083227 review_evidence_guard �� source quote check for approval.
- 20261027083241 host_queue �� durable host research jobs, leases, environment separation and atomic finalization.

These correspond to repository files 202610250001_review_evidence_guard.sql and 202610260001_host_queue.sql. Cloud migration timestamps differ because the managed migration service assigns execution timestamps; do not replay them under the old local version numbers. Reconcile baseline/history before introducing automated CLI database push.

Hosted database rollback verification passed: duplicate enqueue coalesces, a claimed job cannot be claimed again, valid heartbeat succeeds, random/stale token fails, repeated finalization is idempotent. Temporary fixtures were rolled back. This used SQL role/JWT simulation, not browser login, a real Worker or paid provider requests.

Post-check counts: projects=2, sources=1, findings=0, research_jobs=0. Queue RLS enabled. Anonymous read denied; authenticated worker claim denied; service-role worker claim allowed. Quote guard installed.

The Supabase connection authorizes management operations; it does not populate local .env.host. Local Worker service-role and DeepSeek credentials remain a separate configuration requirement. Real end-to-end research and user acceptance are not yet verified.

Additional security correction deployed:
- 20261027083440 restrict_event_trigger_execution: revoked public/anonymous/authenticated RPC execution of the internal rls_auto_enable event-trigger helper. Verified both anonymous and authenticated execute privileges are false.
- enqueue_research remains intentionally authenticated and security-definer, with explicit project ownership validation and a fixed empty search_path. It must atomically insert jobs and update project status beyond user table-write privileges. Its advisor warning is reviewed/expected for this design, not evidence that every user can enqueue another owner's project.
- Leaked-password protection remains disabled in Auth; no authentication plan/settings change was made. See https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection .
- Definer execution review reference: https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable .
