// Runs one agent turn against the real agent runtime with a scripted model.
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {openAgentStore} from '../../server/agent-config.mjs';
import {createAgentRuntime} from '../../server/agent-runtime.mjs';

const root = process.argv[2];
if (!root) throw Error('agent root is required');
const store = openAgentStore(root);
const skillPaths = store.enabledSkillPaths();

const faux = fauxProvider();
const modelRuntime = await ModelRuntime.create({authPath: join(root, 'agent', 'auth.json'), modelsPath: null, refreshOnCreate: false});
modelRuntime.registerNativeProvider(faux.provider);
const model = faux.getModel();
faux.setResponses([
 fauxAssistantMessage([fauxToolCall('mcp__mock__echo', {text: 'hi'})], {stopReason: 'toolUse'}),
 fauxAssistantMessage([fauxText('echoed through MCP')]),
]);
const chat = createAgentRuntime({
 store,
 model,
 modelRuntime,
 workspaceRoot: join(root, 'workspaces'),
 agentDir: join(root, 'agent'),
});
const events = [];
const result = await chat({projectId: 'probe', message: 'Echo hi', onEvent: event => events.push(event)});
console.log(JSON.stringify({
 tools: events.filter(event => event.type === 'tool_start').map(event => event.tool),
 ends: events.filter(event => event.type === 'tool_end').map(event => event.ok),
 skills: skillPaths.length,
 text: result.text,
}));
process.exit(0);
