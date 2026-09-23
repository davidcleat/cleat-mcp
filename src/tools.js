/**
 * The four tools, and their handlers.
 *
 * The names and arguments match Cleat's own hosted MCP server, so a prompt
 * written against one works against the other.
 *
 * Handlers return plain objects. `src/server.js` wraps them for MCP; the tests
 * call them directly.
 */

import { armLine, latestCode, waitForCode } from "./watch.js";

export const MAX_WAIT_SECONDS = 300;
export const DEFAULT_WAIT_SECONDS = 30;

export const tools = [
  {
    name: "list_lines",
    description:
      "List the US mobile lines in this API key's workspace, newest first. Every other tool takes a lineId from here.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_messages",
    description:
      "Recent texts and transcribed calls received by one line, newest first. Read `body` as well as `code`: `code` is a best-effort extraction and can be null.",
    inputSchema: {
      type: "object",
      properties: {
        lineId: { type: "string", description: "The line's id, from list_lines." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 20,
          description: "How many messages to return. 1 to 200.",
        },
      },
      required: ["lineId"],
      additionalProperties: false,
    },
  },
  {
    name: "latest_code",
    description:
      "The most recent verification code already on a line, or found: false if none has arrived. Use wait_for_code instead when the code has not been sent yet.",
    inputSchema: {
      type: "object",
      properties: {
        lineId: { type: "string", description: "The line's id, from list_lines." },
        from: {
          type: "string",
          description: "Optional. Only consider senders containing this text, e.g. a short code.",
        },
        service: {
          type: "string",
          description:
            "Optional. Only consider messages Cleat attributed to this service, e.g. 'facebook'.",
        },
      },
      required: ["lineId"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_code",
    description:
      "Wait for the NEXT code to arrive on a line and return it. A code that was already in the inbox when the call started is never returned. Call this immediately before the step that sends the text, then complete that step while it waits.",
    inputSchema: {
      type: "object",
      properties: {
        lineId: { type: "string", description: "The line's id, from list_lines." },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_WAIT_SECONDS,
          default: DEFAULT_WAIT_SECONDS,
          description: `How long to wait. 1 to ${MAX_WAIT_SECONDS} seconds.`,
        },
        from: {
          type: "string",
          description: "Optional. Only accept senders containing this text.",
        },
        service: {
          type: "string",
          description: "Optional. Only accept messages Cleat attributed to this service.",
        },
      },
      required: ["lineId"],
      additionalProperties: false,
    },
  },
];

function requireLineId(args) {
  const lineId = args?.lineId;
  if (typeof lineId !== "string" || lineId.trim() === "") {
    throw new Error("lineId is required. Call list_lines first to get one.");
  }
  return lineId;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * One message, in exactly the shape the REST API and the hosted MCP server return, so a
 * prompt written against one server reads the same fields on the other. Nothing is
 * flattened or dropped here: `service` and `contact` stay objects, `line` stays.
 */
function publicMessage(message) {
  return {
    id: message.id,
    line: message.line ?? null,
    from: message.from,
    body: message.body,
    code: message.code ?? null,
    receivedAt: message.receivedAt,
    service: message.service ?? null,
    contact: message.contact ?? null,
    label: message.label ?? null,
  };
}

/**
 * @param {object} client                from createClient()
 * @param {object} [deps]               injected in tests
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.pollIntervalMs]
 */
export function createHandlers(client, deps = {}) {
  const { now, sleep, pollIntervalMs = 2_000 } = deps;

  return {
    async list_lines() {
      const lines = await client.listLines();
      return {
        lines: lines.map((line) => ({
          id: line.id,
          phone: line.phone,
          label: line.label ?? null,
          status: line.status,
          createdAt: line.createdAt,
        })),
      };
    },

    async list_messages(args = {}) {
      const lineId = requireLineId(args);
      const limit = clamp(args.limit ?? 20, 1, 200, 20);
      const messages = await client.listMessages(lineId, { limit });
      return { messages: messages.map(publicMessage) };
    },

    async latest_code(args = {}) {
      const lineId = requireLineId(args);
      const result = await latestCode(client, {
        lineId,
        from: args.from,
        service: args.service,
      });
      if (!result.found) {
        return { found: false, reason: "No message with a code on this line yet." };
      }
      return { found: true, ...publicMessage(result.message) };
    },

    async wait_for_code(args = {}) {
      const lineId = requireLineId(args);
      const timeoutSeconds = clamp(
        args.timeoutSeconds ?? DEFAULT_WAIT_SECONDS,
        1,
        MAX_WAIT_SECONDS,
        DEFAULT_WAIT_SECONDS,
      );

      // Read the inbox first, so a code from an earlier sign-in is never
      // mistaken for this one.
      const armed = await armLine(client, lineId);

      const result = await waitForCode(client, {
        ...armed,
        timeoutMs: timeoutSeconds * 1_000,
        pollIntervalMs,
        from: args.from,
        service: args.service,
        now,
        sleep,
      });

      if (!result.found) {
        return {
          found: false,
          timedOut: true,
          waitedSeconds: Math.round(result.waitedMs / 1_000),
          reason: `No new code in ${timeoutSeconds}s. This is an ordinary result: send the code again and retry, or read list_messages.`,
        };
      }
      return { found: true, ...publicMessage(result.message) };
    },
  };
}
