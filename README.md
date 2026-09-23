# cleat-mcp

A local MCP server that lets an assistant read the texts and transcribed calls arriving on your own [Cleat](https://cleat.so) US mobile line, including waiting for the next verification code.

Cleat rents ID-verified US mobile numbers that receive SMS/2FA codes and transcripts of incoming calls. It is receive-only: no outbound texts, no outbound calls, no 911. This server exposes four read tools over stdio, so an assistant can finish a sign-in on an account you already hold instead of asking you to read a code off your phone.

## Install

Node 20 or newer. This is not on npm; clone it.

```bash
git clone https://github.com/davidcleat/cleat-mcp.git
cd cleat-mcp
npm install
```

## Use it

Add this to your MCP client's config, with the absolute path to your clone, and restart the client.

**Claude Desktop** — `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "cleat": {
      "command": "node",
      "args": ["/absolute/path/to/cleat-mcp/bin/cleat-mcp.js"],
      "env": {
        "CLEAT_API_KEY": "clt_your_api_key"
      }
    }
  }
}
```

**Claude Code** — `.mcp.json` in the project root, same shape:

```json
{
  "mcpServers": {
    "cleat": {
      "command": "node",
      "args": ["/absolute/path/to/cleat-mcp/bin/cleat-mcp.js"],
      "env": { "CLEAT_API_KEY": "clt_your_api_key" }
    }
  }
}
```

Check it before you wire it up — this prints the tool list and exits:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | CLEAT_API_KEY=clt_your_api_key node bin/cleat-mcp.js
```

Then ask for the code:

> Log into my staging account at localhost:3000 with the credentials in `.env.test`. When it asks for the SMS code, call `wait_for_code` on my Cleat line first, then submit whatever arrives.

The assistant calls `list_lines` to find the line, `wait_for_code` before the step that sends the text, and reads the code out of the result.

### The four tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_lines` | — | Every line in the key's workspace, newest first: `id`, `phone`, `label`, `status`, `createdAt`. Start here; the rest take a `lineId`. |
| `list_messages` | `lineId`, `limit` (1–200, default 20) | Recent texts and call transcripts, newest first. Each one is a Cleat message: `id`, `line`, `from`, `body`, `code`, `receivedAt`, `service`, `contact`, `label` — the same fields the REST API returns. |
| `latest_code` | `lineId`, `from?`, `service?` | The most recent code already on the line, or `found: false`. Returns `found: true` and the message's fields. |
| `wait_for_code` | `lineId`, `timeoutSeconds` (1–300, default 30), `from?`, `service?` | The **next** code to arrive, or `found: false, timedOut: true`. |

`from` is a case-insensitive substring of the sender (a short code, say `32665`). `service` is matched against the service Cleat recognised from the text — `facebook`, `stripe` — and against the workspace label.

### Why `wait_for_code` and not polling

`wait_for_code` reads where the inbox stands before it starts waiting, then only accepts messages that arrive after that point. A code left over from an earlier sign-in is never returned as this one. That baseline is the `receivedAt` of the newest message the line already has — a server timestamp — so a local clock that is off does not widen or narrow the window.

The order that matters: call `wait_for_code`, **then** do the thing that sends the text. It is already listening.

A timeout is an ordinary result (`found: false, timedOut: true`), not an error, so the assistant can send the code again and retry. Errors the key causes — an expired key, a line the key cannot reach — come back as readable tool errors instead of crashing the server.

### Hosted or local

Cleat already runs a hosted MCP server at `https://cleat.so/api/mcp`, listed in the MCP registry as `so.cleat/cleat`. It exposes the same four tool names, the same arguments and the same message fields, so a prompt written for one works with the other. Pick on these differences:

| | Hosted (`https://cleat.so/api/mcp`) | This package (local, stdio) |
| --- | --- | --- |
| Transport | HTTP JSON-RPC | stdio — works with clients that only speak stdio |
| Install | none | Node 20+ and a clone |
| Where the key lives | in your client's headers config | in your client's `env` block, on your machine |
| Who Cleat sees | your client's requests | your machine's requests |
| `wait_for_code` ceiling | 55 seconds | 300 seconds, subject to your client's own request timeout |
| How a wait notices a code | the line's own live event, so it answers as the text lands | polls every 2 seconds |
| A timeout's answer | `found: false, timedOut: true` | the same, plus `waitedSeconds` and a `reason` for the model to read |
| Code you can read and patch | no | yes |

Both read the same REST API and can see exactly what the API key allows. If you have no reason to self-host, the hosted endpoint is less to maintain. Use this one to raise the wait ceiling, to keep the key off a headers config, to run behind your own egress rules, or to change the tools.

## Get an API key

1. Create a Cleat account at [cleat.so](https://cleat.so) and subscribe to a line — $24.99/month or $249.90/year.
2. Verify your identity once, with a government ID. Until the workspace owner has verified, reading a line answers `403` with `code` `verify_first`: the line runs and keeps every text, but nobody can read them. `list_lines` still works, so you can find the line id before verifying.
3. In **workspace settings → API keys**, create a key. It starts with `clt_` and is shown once.

### Scope the key before you hand it to an agent

When you create a key you can narrow it two ways, and both matter here:

- **To named lines.** A line outside the key's scope answers `404`, exactly as another workspace's line does. Give the key the one line the assistant is meant to read, not the workspace.
- **To an expiry date.** After it, the key answers `401` with code `key_expired`. Set one — an assistant's key should stop working by itself.

That is what makes a key safe to put in a config file an assistant can reach. Revoking a key locks the assistant out on its next call and touches nothing else: no password, no session, no other line.

Only the workspace owner can create keys.

## Limits

- **Receive-only.** A Cleat line cannot send a text, place a call, or reach 911 or any other emergency number. There is no tool here that tries; the API has no endpoint for it. An incoming call is transcribed and lands like a text, with the transcript in `body` and the caller in `from`. Nothing marks a message as having been a call.
- **US numbers.** One line, one subscription, no area code choice, no pools.
- **One verified owner per line.** Identity is checked once, for the account, by a person. An agent cannot verify, and cannot sign itself up.
- **120 requests per minute per key.** `wait_for_code` polls once every 2 seconds while it waits, so one wait costs about 30 requests a minute. Over the limit the API answers `429`; a wait in progress rides it out and keeps waiting.
- **`code` is best effort.** Cleat extracts what looks like a one-time code, and that field can be `null`. The full text is always in `body` — read it when it matters.
- **A line on hold cannot be read.** If a subscription lapses, texts are kept but the API answers `402` until it resumes.
- Cleat cannot tell you that a particular service will accept its numbers. No provider can. Try yours.

## What this is for

Accounts you or your company already hold: a shared business login whose 2FA lands on the company line, a staging account an end-to-end suite signs into, a console an on-call engineer needs a code for. It is not for creating extra accounts, signing up in bulk, or working around a platform's limits — that is outside what Cleat sells, and an account used that way is closed.

## Links

- [cleat.so](https://cleat.so)
- [Cleat for developers](https://cleat.so/for/developers) — the REST API and signed webhooks
- [Cleat for AI agents](https://cleat.so/for/ai-agents) — the hosted MCP server
- [OpenAPI 3.1 description](https://cleat.so/openapi.json)

MIT licensed.
