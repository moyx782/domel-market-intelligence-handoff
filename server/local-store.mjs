// Single-user local store for the demo build.
//
// One JSON file, one process, atomic replace on every write. It mirrors the
// fields and review/report rules of the Supabase schema so the same frontend
// works without authentication, while the multi-user backend stays untouched.

import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const TABLES = ['projects', 'sources', 'findings', 'audits', 'reports', 'jobs'];
const empty = () => ({projects: [], sources: [], findings: [], audits: [], reports: [], jobs: []});
const now = () => new Date().toISOString();

export function openLocalStore(file) {
 let data;
 try {
  data = JSON.parse(readFileSync(file, 'utf8'));
 } catch {
  data = empty();
 }
 for (const table of TABLES) if (!Array.isArray(data[table])) data[table] = [];
 let chain = Promise.resolve();
 const persist = () => {
  mkdirSync(dirname(file), {recursive: true});
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify(data, null, 2));
  renameSync(temp, file);
 };
 const read = work => chain.then(() => work(structuredClone(data)));
 const mutate = work => {
  const run = chain.then(() => {
   const next = structuredClone(data);
   const result = work(next);
   data = next;
   persist();
   return structuredClone(result);
  });
  chain = run.catch(() => {});
  return run;
 };
 const findProject = (state, id) => state.projects.find(project => project.id === id);
 const projectOrThrow = (state, id) => {
  const project = findProject(state, id);
  if (!project) throw Error('Project not accessible');
  return project;
 };

 return {
  file,

  bundle() {
   return read(state => ({
    projects: state.projects,
    sources: state.sources,
    findings: state.findings,
    audits: state.audits,
    reports: state.reports,
   }));
  },

  project(id) {
   return read(state => findProject(state, id) ?? null);
  },

  sources(projectId) {
   return read(state => state.sources.filter(source => source.project_id === projectId));
  },

  findings(projectId) {
   return read(state => state.findings.filter(finding => finding.project_id === projectId));
  },

  jobs() {
   return read(state => state.jobs);
  },

  createProject(input) {
   return mutate(state => {
    const stamp = now();
    const project = {
     id: randomUUID(),
     owner_id: 'local-user',
     title: input.title,
     question: input.question,
     segment: input.segment,
     market: input.market,
     quarter: input.quarter,
     competitors: input.competitors,
     focus: input.focus,
     source_urls: input.source_urls ?? [],
     status: 'draft',
     stage: 'Not started',
     errors: [],
     created_at: stamp,
     updated_at: stamp,
    };
    state.projects.unshift(project);
    return project;
   });
  },

  enqueue(projectId, mode) {
   return mutate(state => {
    const project = projectOrThrow(state, projectId);
    const active = state.jobs.find(job => job.project_id === projectId && (job.state === 'queued' || job.state === 'running'));
    if (active) {
     if (active.mode !== mode) throw Error('Project already queued in another mode');
     return active;
    }
    if (mode === 'extract') {
     const hasSources = state.sources.some(source => source.project_id === projectId);
     const hasFindings = state.findings.some(finding => finding.project_id === projectId);
     if (!['partial', 'failed', 'completed'].includes(project.status) || !hasSources || hasFindings) {
      throw Error('Saved extraction is unavailable');
     }
    } else if (project.status !== 'draft') {
     throw Error('Create a new project for a new research run');
    }
    const stamp = now();
    const job = {
     id: randomUUID(),
     project_id: projectId,
     environment: 'local',
     mode,
     state: 'queued',
     priority: 1,
     attempt: 0,
     created_at: stamp,
     updated_at: stamp,
    };
    state.jobs.unshift(job);
    project.status = 'running';
    project.stage = 'Queued on local demo';
    project.updated_at = stamp;
    return job;
   });
  },

  startJob(jobId) {
   return mutate(state => {
    const job = state.jobs.find(item => item.id === jobId);
    if (!job) throw Error('Job not found');
    job.state = 'running';
    job.attempt += 1;
    job.updated_at = now();
    const project = findProject(state, job.project_id);
    if (project) {
     project.stage = 'Running on local demo';
     project.updated_at = now();
    }
    return job;
   });
  },

  completeJob(jobId, result, savedSources) {
   return mutate(state => {
    const job = state.jobs.find(item => item.id === jobId);
    if (!job) throw Error('Job not found');
    if (job.state === 'succeeded' || job.state === 'failed') return job;
    const project = projectOrThrow(state, job.project_id);
    const stamp = now();
    for (const source of savedSources) {
     if (job.mode === 'extract') {
      if (!state.sources.some(item => item.id === source.id && item.project_id === project.id)) throw Error('Saved source not accessible');
     } else {
      state.sources.push({
       id: source.id,
       project_id: project.id,
       url: source.url,
       title: source.title,
       published_at: source.published_at ?? null,
       retrieved_at: source.retrieved_at,
       text: source.text,
       competitor: 'Source-level evidence',
      });
     }
     for (const finding of source.findings ?? []) {
      state.findings.push({
       id: randomUUID(),
       project_id: project.id,
       source_id: source.id,
       competitor: finding.competitor,
       field: finding.field,
       original_text: finding.text,
       edited_text: finding.text,
       quote: finding.quote,
       decision: 'pending',
       revision: 1,
       reviewer_id: null,
       reviewed_at: null,
      });
     }
    }
    project.status = result.status;
    project.stage = result.stage;
    project.errors = result.errors;
    project.updated_at = stamp;
    job.state = result.status === 'failed' ? 'failed' : 'succeeded';
    job.updated_at = stamp;
    return job;
   });
  },

  // `force` lets the task queue record a user cancellation that raced with a
  // successful run: the queue state is authoritative, so the project/job must
  // not keep claiming success afterwards.
  failJob(jobId, message, {force = false} = {}) {
   return mutate(state => {
    const job = state.jobs.find(item => item.id === jobId);
    if (!job || (!force && (job.state === 'succeeded' || job.state === 'failed'))) return job;
    const project = findProject(state, job.project_id);
    const stamp = now();
    if (project) {
     project.status = 'failed';
     project.stage = 'Research could not complete';
     project.errors = [...(project.errors ?? []), message];
     project.updated_at = stamp;
    }
    job.state = 'failed';
    job.updated_at = stamp;
    return job;
   });
  },

  review(findingId, text, decision, revision) {
   return mutate(state => {
    if (!['pending', 'accepted', 'rejected'].includes(decision)) throw Error('Invalid decision');
    const trimmed = String(text ?? '').trim();
    if (!trimmed || trimmed.length > 4000) throw Error('Invalid finding wording');
    const finding = state.findings.find(item => item.id === findingId);
    if (!finding) throw Error('Finding not accessible');
    if (finding.revision !== revision) throw Error('This finding changed. Refresh and try again.');
    const oldText = finding.edited_text;
    const changed = trimmed !== oldText;
    finding.edited_text = trimmed;
    finding.decision = changed ? 'pending' : decision;
    finding.revision += 1;
    finding.reviewer_id = changed || decision === 'pending' ? null : 'local-user';
    finding.reviewed_at = changed || decision === 'pending' ? null : now();
    state.audits.unshift({
     id: randomUUID(),
     project_id: finding.project_id,
     finding_id: finding.id,
     actor_id: 'local-user',
     action: changed ? 'edit' : decision,
     old_text: oldText,
     new_text: finding.edited_text,
     decision: finding.decision,
     created_at: now(),
     revision: finding.revision,
    });
    return finding;
   });
  },

  generateReport(projectId) {
   return mutate(state => {
    const project = projectOrThrow(state, projectId);
    const approved = state.findings.filter(finding => finding.project_id === projectId && finding.decision === 'accepted');
    if (!approved.length) throw Error('Accept at least one finding before generating a report.');
    const sourceIds = new Set(approved.map(finding => finding.source_id));
    const version = state.reports.filter(report => report.project_id === projectId).reduce((max, report) => Math.max(max, report.version), 0) + 1;
    const report = {
     id: randomUUID(),
     project_id: projectId,
     version,
     created_at: now(),
     snapshot: {
      project: structuredClone(project),
      findings: structuredClone(approved),
      sources: structuredClone(state.sources.filter(source => sourceIds.has(source.id))),
      limitations: [
       'Only human-approved findings are included. Missing information means insufficient evidence, not absence of competitor activity.',
       ...(project.errors ?? []),
      ],
     },
    };
    state.reports.unshift(report);
    return report;
   });
  },
 }
}
