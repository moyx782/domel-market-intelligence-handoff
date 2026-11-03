// Research execution shared by the legacy inline runner and the durable task
// queue. The pipeline itself (search, fetch, extract, validate) lives in the
// Supabase shared modules; this file only adapts the local JSON store to it so
// the API and the task handlers use exactly the same behaviour.

import {randomUUID} from 'node:crypto';
import {publicSourceUrl, sourcePolicy} from '../supabase/functions/_shared/source-policy.mjs';
import {createDeepSeekSources} from '../supabase/functions/_shared/deepseek-search.mjs';
import {extractionConfig, extractCandidates} from '../supabase/functions/_shared/ai-extraction.mjs';
import {validateFindings} from '../supabase/functions/_shared/research-validation.mjs';
import {collectResearch, extractSavedResearch} from '../supabase/functions/_shared/research-workflow.mjs';

export function extractionReady(env) {
 return Boolean(extractionConfig(name => env[name]));
}

// One research job = one project, mode collect/research/extract. The job record
// in the local store keeps the project status in sync for the existing UI.
export function createResearchRunner({store, env}) {
 return async function runResearchJob(job) {
  const project = await store.project(job.project_id);
  if (!project) throw Error('Project not accessible');
  const policy = sourcePolicy(name => env[name]);
  const allowUrl = raw => publicSourceUrl(raw, policy.restrictedDomains);
  const adapter = createDeepSeekSources({
   apiKey: env.DEEPSEEK_API_KEY,
   allowedDomains: policy.restrictedDomains,
   allowUrl,
   requestTimeoutMs: 30000,
  });
  const config = extractionConfig(name => env[name]);
  const saved = [];
  let outcome;
  const io = {
   now: () => Date.now(),
   aiReady: !!config,
   maxSources: 5,
   defaultSourceUrls: policy.defaultSourceUrls,
   normalizeUrl: allowUrl,
   notices: adapter.notices,
   stage: async () => {},
   discover: () => adapter.discover(project),
   fetchSource: adapter.fetchSource,
   saveSource: async source => {
    const id = randomUUID();
    saved.push({...source, id, retrieved_at: new Date().toISOString(), findings: []});
    return id;
   },
   extract: async (project, source) => extractCandidates(project, source, config, validateFindings),
   saveFindings: async (id, findings) => {
    const source = saved.find(item => item.id === id);
    if (!source) throw Error('Saved source unavailable');
    source.findings.push(...findings);
   },
   finish: async result => { outcome = result; },
  };
  if (job.mode === 'extract') await extractSavedResearch(project, await store.sources(project.id), io);
  else await collectResearch(project, io, job.mode === 'research');
  if (!outcome) throw Error('Research produced no result');
  await store.completeJob(job.id, outcome, saved);
  return outcome;
 };
}
