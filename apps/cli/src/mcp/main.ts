/** `redpen mcp` entrypoint — starts the stdio MCP server. */
import { runMcpServer } from './server.js';

runMcpServer().catch((err) => {
  console.error('MCP server failed:', err);
  process.exit(1);
});
