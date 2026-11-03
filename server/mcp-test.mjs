// Probe one MCP server: start the transport, initialize, list tools, close.
import {McpClient, StdioTransport, StreamableHttpTransport} from '@earendil-works/pi-mcp';

export async function testMcpServer(server, {timeoutMs = 15000} = {}) {
 if (!server || (!server.command && !server.url)) throw Error('MCP server needs command or url');
 const transport = server.url
  ? new StreamableHttpTransport({url: server.url, headers: server.headers ?? {}, openGetStream: false})
  : new StdioTransport({
   command: server.command,
   args: server.args ?? [],
   env: server.env ?? {},
   cwd: process.cwd(),
   stderr: 'pipe',
  });
 const client = new McpClient({name: 'domel-demo', version: '1.0', requestTimeoutMs: timeoutMs});
 let timer;
 const timeout = new Promise((_, reject) => {
  timer = setTimeout(() => reject(Error('MCP test timed out after ' + timeoutMs + 'ms')), timeoutMs);
  timer.unref?.();
 });
 try {
  const init = await Promise.race([client.connect(transport), timeout]);
  const result = await Promise.race([client.request('tools/list'), timeout]);
  return {
   ok: true,
   serverInfo: init.serverInfo,
   protocolVersion: init.protocolVersion,
   tools: (result.tools ?? []).map(tool => ({name: tool.name, description: tool.description ?? ''})),
  };
 } finally {
  clearTimeout(timer);
  await client.close().catch(() => {});
  await transport.close?.().catch(() => {});
 }
}
