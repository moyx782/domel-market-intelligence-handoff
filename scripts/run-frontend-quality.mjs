#!/usr/bin/env node
// One-command frontend automation:
//   npm run test:frontend
//
// Prepare isolated data, start the local API and Vite, run the Playwright
// quality matrix (scripts/frontend-quality.mjs), then clean everything up.
// Override ports with QUALITY_API_PORT / QUALITY_UI_PORT.

import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const REPO = join(HERE, '..');
const API_PORT = Number(process.env.QUALITY_API_PORT || 8793);
const UI_PORT = Number(process.env.QUALITY_UI_PORT || 5178);
const DATA = process.env.ACCEPTANCE_DATA_DIR || mkdtempSync(join(tmpdir(), 'domel-quality-'));
const KEEP = process.env.QUALITY_KEEP_DATA === '1';
const children = [];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(command, args, {env = process.env, label = command, inherit = false} = {}) {
 return new Promise((resolve, reject) => {
  const child = spawn(command, args, {
   cwd: REPO,
   env,
   stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  if (!inherit) {
   child.stdout.on('data', chunk => process.stdout.write('[' + label + '] ' + chunk));
   child.stderr.on('data', chunk => process.stderr.write('[' + label + '] ' + chunk));
  }
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(Error(label + ' exited with ' + code)));
 });
}

async function waitFor(url, timeoutMs = 30000) {
 const deadline = Date.now() + timeoutMs;
 while (Date.now() < deadline) {
  try {
   const response = await fetch(url);
   if (response.ok) return true;
  } catch { /* not ready */ }
  await sleep(250);
 }
 return false;
}

function stop() {
 for (const child of children) {
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
 }
}

const dataEnv = {
 ...process.env,
 ACCEPTANCE_DATA_DIR: DATA,
 LOCAL_DATA_FILE: join(DATA, 'domel.json'),
 AGENT_DATA_DIR: DATA,
 AGENT_TRANSCRIPT_FILE: join(DATA, 'agent', 'transcripts.json'),
 TASKS_FILE: join(DATA, 'tasks.json'),
 EVENTS_FILE: join(DATA, 'events.json'),
 SOURCES_FILE: join(DATA, 'source-registry.json'),
 DOCUMENTS_FILE: join(DATA, 'documents.json'),
 RECIPES_FILE: join(DATA, 'recipes.json'),
 AGENT_WORKSPACE_ROOT: join(DATA, 'workspaces'),
 ASSISTANT_SESSION_DIR: join(DATA, 'assistant'),
 AGENT_SKILLS_SEED: 'seed/skills',
 LOCAL_API_PORT: String(API_PORT),
 LOCAL_API_BIND: '127.0.0.1',
 APP_ORIGINS: 'http://127.0.0.1:' + UI_PORT + ',http://127.0.0.1:5174',
};

try {
 console.log('Frontend quality: preparing isolated data in ' + DATA);
 await run(process.execPath, ['scripts/acceptance-api.mjs', '--prepare', '--fixtures'], {env: dataEnv, label: 'prepare'});

 console.log('Frontend quality: starting API on ' + API_PORT);
 const api = spawn(process.execPath, ['server/local-api.mjs'], {cwd: REPO, env: dataEnv, stdio: ['ignore', 'pipe', 'pipe']});
 children.push(api);
 api.stdout.on('data', chunk => process.stdout.write('[api] ' + chunk));
 api.stderr.on('data', chunk => process.stderr.write('[api] ' + chunk));
 if (!(await waitFor('http://127.0.0.1:' + API_PORT + '/health'))) throw Error('API did not become healthy');

 console.log('Frontend quality: starting Vite on ' + UI_PORT);
 const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(UI_PORT)], {
  cwd: REPO,
  env: {...dataEnv, VITE_BACKEND_URL: 'http://127.0.0.1:' + API_PORT},
  stdio: ['ignore', 'pipe', 'pipe'],
 });
 children.push(ui);
 ui.stdout.on('data', chunk => process.stdout.write('[vite] ' + chunk));
 ui.stderr.on('data', chunk => process.stderr.write('[vite] ' + chunk));
 if (!(await waitFor('http://127.0.0.1:' + UI_PORT + '/', 45000))) throw Error('Vite did not start');

 const quality = spawn(process.execPath, ['scripts/frontend-quality.mjs'], {
  cwd: REPO,
  env: {
   ...dataEnv,
   BASE: 'http://127.0.0.1:' + UI_PORT,
   API_BASE: 'http://127.0.0.1:' + API_PORT,
   ACCEPTANCE_DATA_DIR: DATA,
   QUALITY_EVIDENCE_DIR: process.env.QUALITY_EVIDENCE_DIR || join(REPO, 'evidence', 'frontend-quality'),
  },
  stdio: 'inherit',
 });
 const code = await new Promise(resolve => quality.on('exit', resolve));
 stop();
 await sleep(300);
 if (code !== 0) throw Error('frontend-quality exited with ' + code);
 console.log('\nFrontend quality automation finished successfully.');
} catch (error) {
 console.error('\nFrontend quality automation failed: ' + (error instanceof Error ? error.message : error));
 process.exitCode = 1;
} finally {
 stop();
 if (!KEEP) {
  try { rmSync(DATA, {recursive: true, force: true}); } catch { /* best effort */ }
 }
}
