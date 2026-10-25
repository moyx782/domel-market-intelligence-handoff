# DeepSeek configuration �� Week 6 update (2026-10-25)

This update supersedes the October 21 requirement for separate AI_* credentials when using DeepSeek.

- Save DEEPSEEK_API_KEY only in Supabase Edge Functions Secrets.
- Search/Fetch use the existing fixed DeepSeek tools endpoints.
- Explicitly starting Collect + AI extract also uses this server key for model extraction. Default model: deepseek-flash. Optional override: DEEPSEEK_MODEL.
- A complete custom AI_BASE_URL, AI_API_KEY and AI_MODEL configuration takes precedence. Partial custom configuration blocks extraction rather than silently switching providers.
- Collection and extraction incur provider usage. Readiness checking does not make a provider call and does not establish that the key/balance/API works.
- No team preset domains have been chosen. SOURCE_ALLOWED_DOMAINS remains the actual administrator policy.

Deploy generated supabase/dashboard/index.ts and the new review migration. See WEEK6_ACCEPTANCE.md for exact steps and evidence requirements.

Official endpoint/model reference checked 2026-10-25: https://api-docs.deepseek.com/zh-cn/
No live deployment or paid provider verification was performed by this local update.
