// Agent report validation: only known materials, exact quotes, no invented facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AGENT_REPORT_FILE, runAgentReport, validateAgentReport} from '../server/agent-report.mjs';

const material = {
 id: 'm1', url: 'https://example.com/ocr.pdf', title: '扫描版名单', kind: 'document', provider: 'vision-ocr', pages: 1, chars: 100, textPath: '/tmp/m1.md',
};
const text = '中国国际制冷展 2026\n上海新国际博览中心\nChina Refrigeration Expo';
const report = {
 reportMarkdown: '# 材料报告\n\n' + '这'.repeat(120),
 materials: [{url: 'https://example.com/ocr.pdf', summary: '扫描件只有展会中英文名和场馆名。', quotes: ['中国国际制冷展 2026']}],
 warnings: ['OCR 材料没有展商名单'],
};

test('agent report accepts known material summaries and exact quotes', () => {
 const result = validateAgentReport(report, {materials: [material], readText: () => text});
 assert.match(result.reportMarkdown, /材料报告/);
 assert.equal(result.materials.length, 1);
 assert.equal(result.materials[0].quotes[0], '中国国际制冷展 2026');
 assert.equal(result.warnings.length, 1);
});

test('agent report drops unknown materials and non-matching quotes', () => {
 const result = validateAgentReport({...report, materials: [
  {...report.materials[0], url: 'https://unknown.example/x', summary: 'unknown'},
  {...report.materials[0], quotes: ['这句话不在材料里，不应该通过校验。']},
 ]}, {materials: [material], readText: () => text});
 // The second entry keeps the known material/summary but drops its quote; a
 // summary is still usable. Unknown URL entries are ignored.
 assert.equal(result.materials.length, 1);
 assert.equal(result.materials[0].quotes.length, 0);
 assert.throws(() => validateAgentReport({...report, reportMarkdown: 'short'}, {materials: [material], readText: () => text}), /100-24000/);
 assert.throws(() => validateAgentReport({...report, materials: []}, {materials: [material], readText: () => text}), /no usable material summaries/);
});

test('runAgentReport reads event-report.json from the agent workspace', async () => {
 const workspace = mkdtempSync(join(tmpdir(), 'domel-agent-report-'));
 let called = null;
 const agentRuntime = async ({projectId, message, onEvent}) => {
  called = {projectId, message};
  onEvent({type: 'tool_start', tool: 'bash'});
  writeFileSync(join(workspace, AGENT_REPORT_FILE), JSON.stringify(report));
  return {text: '已写入', workspace};
 };
 const result = await runAgentReport({
  agentRuntime,
  event: {name: 'China Refrigeration 2026', notes: []},
  materials: [material],
  workspace,
  projectId: 'agent-report-e1',
  readText: () => text,
 });
 assert.equal(called.projectId, 'agent-report-e1');
 assert.match(called.message, /event-report\.json/);
 assert.equal(result.materials.length, 1);
});
