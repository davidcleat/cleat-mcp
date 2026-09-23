#!/usr/bin/env node
/**
 * cleat-mcp — a stdio MCP server over your own Cleat lines.
 *
 * Reads CLEAT_API_KEY from the environment. Optional: CLEAT_BASE_URL.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "../src/server.js";

const apiKey = process.env.CLEAT_API_KEY;

if (!apiKey) {
  process.stderr.write(
    "cleat-mcp: CLEAT_API_KEY is not set.\n" +
      "Create a key in Cleat workspace settings (it starts with clt_), scope it to the\n" +
      "line the assistant may read, give it an expiry, and put it in the env block of\n" +
      "your MCP client config.\n",
  );
  process.exit(1);
}

// stdout is the MCP transport. Anything we want to say goes to stderr.
const server = createServer({ apiKey, baseUrl: process.env.CLEAT_BASE_URL });

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`cleat-mcp: failed to start: ${error.message}\n`);
  process.exit(1);
}
