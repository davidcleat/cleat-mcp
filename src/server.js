/**
 * MCP wiring. All the logic lives in ./tools.js and ./watch.js; this file only
 * turns handler results into MCP tool results.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createClient } from "./client.js";
import { createHandlers, tools } from "./tools.js";

export const SERVER_NAME = "cleat-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.baseUrl]
 * @param {typeof globalThis.fetch} [options.fetch]
 */
export function createServer({ apiKey, baseUrl, fetch: fetchImpl } = {}) {
  const client = createClient({ apiKey, baseUrl, fetch: fetchImpl });
  const handlers = createHandlers(client);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers[request.params.name];
    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      };
    }

    try {
      const result = await handler(request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      // A readable tool error, not a crash: the model can act on it.
      const status = error?.status ? ` (HTTP ${error.status})` : "";
      return {
        isError: true,
        content: [{ type: "text", text: `${error.message}${status}` }],
      };
    }
  });

  return server;
}
