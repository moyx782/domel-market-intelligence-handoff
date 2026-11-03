// Minimal stdio MCP server used by the agent runtime test.
import {createInterface} from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({input: process.stdin}).on('line', line => {
 let request;
 try { request = JSON.parse(line); } catch { return; }
 if (request.method === 'initialize') {
  send({jsonrpc: '2.0', id: request.id, result: {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'echo', version: '1.0'}}});
 } else if (request.method === 'tools/list') {
  send({jsonrpc: '2.0', id: request.id, result: {tools: [{name: 'echo', description: 'Echo text back', inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}}]}});
 } else if (request.method === 'tools/call') {
  send({jsonrpc: '2.0', id: request.id, result: {content: [{type: 'text', text: 'echo:' + request.params.arguments.text}]}});
 } else if (request.method === 'notifications/initialized') {
  // notification, no response
 } else if (request.id !== undefined) {
  send({jsonrpc: '2.0', id: request.id, error: {code: -32601, message: 'Method not found'}});
 }
});
