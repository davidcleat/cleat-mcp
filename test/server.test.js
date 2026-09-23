/**
 * The MCP surface itself, over an in-memory transport: no stdio, no network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";
import { LINE_ID, TEST_BASE_URL, TEST_KEY, message, stubFetch } from "./helpers.js";

const LINE = {
  id: LINE_ID,
  phone: "13055550100",
  label: "Staging sign-ups",
  status: "active",
  createdAt: "2026-09-11T10:00:00.000Z",
};

async function connect({ messages = [] } = {}) {
  const stub = stubFetch({ lines: [LINE], messages });
  const server = createServer({ apiKey: TEST_KEY, baseUrl: TEST_BASE_URL, fetch: stub.fetch });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, stub };
}

test("the server advertises the four tools with usable schemas", async () => {
  const { client } = await connect();

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["latest_code", "list_lines", "list_messages", "wait_for_code"],
  );

  const wait = tools.find((tool) => tool.name === "wait_for_code");
  assert.deepEqual(wait.inputSchema.required, ["lineId"]);
  assert.equal(wait.inputSchema.properties.timeoutSeconds.maximum, 300);
  // The description has to tell the model about the stale-code guarantee.
  assert.match(wait.description, /already in the inbox/i);
});

test("calling a tool returns both readable text and structured content", async () => {
  const { client } = await connect({
    messages: [
      message({ id: "m1", body: "704118 is your code", code: "704118", receivedAt: "2026-09-11T10:02:41.000Z" }),
    ],
  });

  const result = await client.callTool({ name: "latest_code", arguments: { lineId: LINE_ID } });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.code, "704118");
  assert.match(result.content[0].text, /704118/);
});

test("an out-of-scope line comes back as a readable tool error, not a crash", async () => {
  const { client } = await connect();

  const result = await client.callTool({
    name: "list_messages",
    arguments: { lineId: "11111111-2222-3333-4444-555555555555" },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No line with that id/);
  assert.match(result.content[0].text, /HTTP 404/);
});

test("an unknown tool name is reported rather than thrown", async () => {
  const { server } = await connect();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server;
  const other = createServer({
    apiKey: TEST_KEY,
    baseUrl: TEST_BASE_URL,
    fetch: stubFetch({ lines: [LINE] }).fetch,
  });
  await Promise.all([other.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({ name: "send_text", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown tool: send_text/);
});
