import assert from "node:assert/strict";
import { test } from "node:test";

import { createClient } from "../src/client.js";
import { createHandlers } from "../src/tools.js";
import { LINE_ID, TEST_BASE_URL, TEST_KEY, fakeClock, message, stubFetch } from "./helpers.js";

const LINE = {
  id: LINE_ID,
  phone: "13055550100",
  label: "Staging sign-ups",
  status: "active",
  createdAt: "2026-09-11T10:00:00.000Z",
};

function setup({ lines = [LINE], messages = [], failures = [] } = {}) {
  const stub = stubFetch({ lines, messages, failures });
  const client = createClient({ apiKey: TEST_KEY, baseUrl: TEST_BASE_URL, fetch: stub.fetch });
  const clock = fakeClock();
  const handlers = createHandlers(client, {
    now: clock.now,
    sleep: clock.sleep,
    pollIntervalMs: 2_000,
  });
  return { stub, client, clock, handlers };
}

test("list_lines returns the workspace's lines and sends the bearer key", async () => {
  const { handlers, stub } = setup();

  const result = await handlers.list_lines();

  assert.deepEqual(result.lines, [
    {
      id: LINE_ID,
      phone: "13055550100",
      label: "Staging sign-ups",
      status: "active",
      createdAt: "2026-09-11T10:00:00.000Z",
    },
  ]);
  assert.equal(stub.calls[0].path, "/api/v1/lines");
  assert.equal(stub.calls[0].authorization, `Bearer ${TEST_KEY}`);
});

test("list_messages returns newest first and clamps limit to the API's range", async () => {
  const { handlers, stub } = setup({
    messages: [
      message({ id: "m1", body: "111111 is your code", code: "111111", receivedAt: "2026-09-11T10:00:00.000Z" }),
      message({ id: "m2", body: "222222 is your code", code: "222222", receivedAt: "2026-09-11T10:05:00.000Z" }),
    ],
  });

  const result = await handlers.list_messages({ lineId: LINE_ID, limit: 9999 });

  assert.deepEqual(
    result.messages.map((entry) => entry.id),
    ["m2", "m1"],
  );
  assert.equal(stub.calls[0].query.limit, "200");
});

test("list_messages refuses to guess a line", async () => {
  const { handlers } = setup();
  await assert.rejects(() => handlers.list_messages({}), /lineId is required/);
});

test("latest_code returns the newest code, and reports honestly when there is none", async () => {
  const withCode = setup({
    messages: [
      message({ id: "m1", body: "111111 is your code", code: "111111", receivedAt: "2026-09-11T10:00:00.000Z" }),
      message({ id: "m2", body: "222222 is your code", code: "222222", receivedAt: "2026-09-11T10:05:00.000Z" }),
    ],
  });
  const found = await withCode.handlers.latest_code({ lineId: LINE_ID });
  assert.equal(found.found, true);
  assert.equal(found.code, "222222");

  const withoutCode = setup({
    messages: [message({ id: "m1", body: "Your package is out for delivery", receivedAt: "2026-09-11T10:00:00.000Z" })],
  });
  const missing = await withoutCode.handlers.latest_code({ lineId: LINE_ID });
  assert.equal(missing.found, false);
});

test("latest_code can be narrowed to one service", async () => {
  const { handlers } = setup({
    messages: [
      message({
        id: "m1",
        body: "111111 is your Facebook confirmation code",
        code: "111111",
        receivedAt: "2026-09-11T10:00:00.000Z",
        service: { id: "facebook", name: "Facebook", color: "#0866FF" },
        label: "Facebook",
      }),
      message({ id: "m2", body: "222222 is your code", code: "222222", receivedAt: "2026-09-11T10:05:00.000Z" }),
    ],
  });

  const result = await handlers.latest_code({ lineId: LINE_ID, service: "facebook" });
  assert.equal(result.code, "111111");
});

test("wait_for_code never returns a code that was already in the inbox", async () => {
  const stale = message({
    id: "stale",
    body: "999999 is your code",
    code: "999999",
    receivedAt: "2026-09-11T09:00:00.000Z",
  });
  const { handlers, clock, stub } = setup({ messages: [stale] });

  // The real text lands while we are waiting.
  let delivered = false;
  const sleep = clock.sleep;
  const handlersWithDelivery = createHandlers(
    createClient({ apiKey: TEST_KEY, baseUrl: TEST_BASE_URL, fetch: stub.fetch }),
    {
      now: clock.now,
      sleep: async (ms) => {
        if (!delivered) {
          delivered = true;
          stub.deliver(
            message({
              id: "fresh",
              body: "704118 is your code",
              code: "704118",
              receivedAt: "2026-09-11T10:02:41.000Z",
            }),
          );
        }
        await sleep(ms);
      },
      pollIntervalMs: 2_000,
    },
  );

  const result = await handlersWithDelivery.wait_for_code({ lineId: LINE_ID, timeoutSeconds: 30 });

  assert.equal(result.found, true);
  assert.equal(result.code, "704118");
  assert.equal(result.id, "fresh");
  void handlers;
});

test("wait_for_code times out as an ordinary result, not an error", async () => {
  const { handlers } = setup({
    messages: [
      message({ id: "stale", body: "999999 is your code", code: "999999", receivedAt: "2026-09-11T09:00:00.000Z" }),
    ],
  });

  const result = await handlers.wait_for_code({ lineId: LINE_ID, timeoutSeconds: 10 });

  assert.equal(result.found, false);
  assert.equal(result.timedOut, true);
  assert.ok(result.reason.includes("10s"));
});

test("wait_for_code works on a line whose inbox is empty", async () => {
  const stub = stubFetch({ lines: [LINE], messages: [] });
  const clock = fakeClock();
  let delivered = false;
  const handlers = createHandlers(
    createClient({ apiKey: TEST_KEY, baseUrl: TEST_BASE_URL, fetch: stub.fetch }),
    {
      now: clock.now,
      sleep: async (ms) => {
        if (!delivered) {
          delivered = true;
          stub.deliver(
            message({ id: "first", body: "Your code is 424242", code: "424242", receivedAt: "2026-09-11T10:00:00.000Z" }),
          );
        }
        clock.advance(ms);
      },
    },
  );

  const result = await handlers.wait_for_code({ lineId: LINE_ID, timeoutSeconds: 30 });
  assert.equal(result.code, "424242");
});

test("wait_for_code ignores messages that do not match the sender filter", async () => {
  const stub = stubFetch({ lines: [LINE], messages: [] });
  const clock = fakeClock();
  let step = 0;
  const handlers = createHandlers(
    createClient({ apiKey: TEST_KEY, baseUrl: TEST_BASE_URL, fetch: stub.fetch }),
    {
      now: clock.now,
      sleep: async (ms) => {
        step += 1;
        if (step === 1) {
          stub.deliver(
            message({ id: "other", from: "11115550001", body: "123456 is your code", code: "123456", receivedAt: "2026-09-11T10:01:00.000Z" }),
          );
        }
        if (step === 2) {
          stub.deliver(
            message({ id: "wanted", from: "32665", body: "704118 is your code", code: "704118", receivedAt: "2026-09-11T10:02:00.000Z" }),
          );
        }
        clock.advance(ms);
      },
    },
  );

  const result = await handlers.wait_for_code({ lineId: LINE_ID, timeoutSeconds: 60, from: "32665" });
  assert.equal(result.id, "wanted");
});

test("wait_for_code keeps waiting through a 429 instead of failing", async () => {
  const stub = stubFetch({
    lines: [LINE],
    messages: [],
    failures: [
      { status: 200, body: { data: [] } }, // the arming read
      { status: 429, body: { error: "Too many requests." } },
    ],
  });
  const clock = fakeClock();
  let delivered = false;
  const handlers = createHandlers(
    createClient({ apiKey: TEST_KEY, baseUrl: TEST_BASE_URL, fetch: stub.fetch }),
    {
      now: clock.now,
      sleep: async (ms) => {
        if (!delivered) {
          delivered = true;
          stub.deliver(
            message({ id: "after-429", body: "Code: 555111", code: "555111", receivedAt: "2026-09-11T10:03:00.000Z" }),
          );
        }
        clock.advance(ms);
      },
    },
  );

  const result = await handlers.wait_for_code({ lineId: LINE_ID, timeoutSeconds: 60 });
  assert.equal(result.code, "555111");
});

test("an expired key surfaces as an error with the API's own code", async () => {
  const { handlers } = setup({
    failures: [{ status: 401, body: { error: "This key has expired.", code: "key_expired" } }],
  });

  await assert.rejects(() => handlers.list_lines(), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, "key_expired");
    return true;
  });
});

test("a line outside the key's scope is a 404, same as another workspace's line", async () => {
  const { handlers } = setup();
  await assert.rejects(
    () => handlers.list_messages({ lineId: "11111111-2222-3333-4444-555555555555" }),
    (error) => {
      assert.equal(error.status, 404);
      return true;
    },
  );
});

test("a client without a key fails before it can make a request", () => {
  assert.throws(() => createClient({ apiKey: "" }), /workspace settings/);
});
