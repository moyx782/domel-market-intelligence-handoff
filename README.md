# Domel Market Intelligence

React + TypeScript + Vite frontend, Supabase Auth/PostgreSQL/Edge Functions backend.

## Start on Windows

1. Install Node.js 24.
2. Run `npm.cmd ci` in this repository.
3. Copy `.env.example` to `.env` and enter your Supabase project URL and public publishable key. For interface exploration, the login page also offers a clearly labelled demo.
4. Run `npm.cmd run dev` and open the URL printed by Vite.

Never commit `.env`, database passwords, service-role keys or DeepSeek keys. Frontend VITE variables are public.

## Current features and limits

- Connected research workflow, real Supabase authentication and saved projects.
- Free-text research focus: 1–5 fields, one per line.
- Data sources navigation: team presets intentionally empty. Users can add/remove preferred HTTPS page URLs. Preferences are stored per account in the current browser and prefill new research. This is not cloud preference synchronisation or website-wide search configuration.
- Backend source collection and optional DeepSeek Search/Fetch adapter. Source links, retrieval times and original excerpts remain visible. Search summaries are not evidence.
- Finding review/audit and approved-only report code; real AI extraction needs separate model configuration and end-to-end acceptance.
- Demo fixtures are explicitly illustrative. Do not represent them as real research.

## Supabase setup

For a NEW development project, apply `supabase/migrations/202610140001_initial.sql`. Do not rerun this initial migration against an existing database. Configure invited email/password accounts and correct Auth redirect URLs for your frontend.

Deploy `supabase/functions/research`. To deploy through the dashboard, first run `node scripts/bundle-research.mjs` and paste the generated `supabase/dashboard/index.ts` into the function editor. Keep JWT checks enabled.

Backend-only secrets: DEEPSEEK_API_KEY for Search/Fetch; optional AI_BASE_URL, AI_API_KEY and AI_MODEL for extraction. Configure APP_ORIGINS and SOURCE_ALLOWED_DOMAINS for the actual frontend and approved sources. See DEEPSEEK_SETUP_ZH.md. Local tests do not prove deployed provider or authentication behaviour. Latest free-text focus validation also requires deploying the updated function.

## Checks

`npm.cmd test` runs the Node tests, including embedded PostgreSQL ownership and review tests. `npm.cmd run build` checks TypeScript and builds the frontend.

## Team workflow

See CONTRIBUTING.md. Each member uses an individual branch and submits a pull request. Never force-push shared main or share production credentials through GitHub.
