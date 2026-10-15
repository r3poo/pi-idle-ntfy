import test from "node:test";
import assert from "node:assert/strict";
import { createAwaitingInputState, getLatestAssistantResponse, isAwaitingUserInput, validateConfig } from "../lib/logic.js";
import { sendNotification } from "../lib/ntfy.js";

test("sends ntfy notifications with bearer auth and encoded topic", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestUrl;
  let requestOptions;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(null, { status: 200 });
  };

  await sendNotification(
    { topic: "topic with spaces", server: "https://ntfy.example", token: "tk_secret" },
    "Test title",
    "Test body",
  );
  assert.equal(requestUrl, "https://ntfy.example/topic%20with%20spaces");
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.headers.get("Authorization"), "Bearer tk_secret");
  assert.equal(requestOptions.headers.get("Title"), "Test title");
  assert.equal(requestOptions.body, "Test body");
});

test("sends ntfy notifications with basic auth", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let authorization;
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.get("Authorization");
    return new Response(null, { status: 200 });
  };

  await sendNotification(
    { topic: "alerts", server: "https://ntfy.example", username: "alice", password: "secret" },
    "Test title",
    "Test body",
  );
  assert.equal(authorization, `Basic ${Buffer.from("alice:secret").toString("base64")}`);
});

test("reports ntfy HTTP failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response(null, { status: 401, statusText: "Unauthorized" });

  await assert.rejects(
    sendNotification({ topic: "alerts", server: "https://ntfy.example" }, "Test title", "Test body"),
    /ntfy returned HTTP 401 Unauthorized/,
  );
});

test("uses secure ntfy defaults and validates a topic", () => {
  assert.deepEqual(validateConfig({ topic: "my_topic-1" }), {
    topic: "my_topic-1",
    server: "https://ntfy.sh",
    delayMinutes: 15,
    mode: "idle",
  });
});

test("accepts custom server, zero delay, and bearer token", () => {
  assert.deepEqual(validateConfig({ topic: "alerts", server: "https://ntfy.example/", delayMinutes: 0, token: "secret" }), {
    topic: "alerts",
    server: "https://ntfy.example",
    delayMinutes: 0,
    mode: "idle",
    token: "secret",
  });
});

test("accepts paired basic-auth credentials", () => {
  assert.deepEqual(validateConfig({ topic: "alerts", username: "alice", password: "secret" }), {
    topic: "alerts",
    server: "https://ntfy.sh",
    delayMinutes: 15,
    mode: "idle",
    username: "alice",
    password: "secret",
  });
});

test("rejects unsafe or invalid configuration", () => {
  for (const value of [
    null,
    {},
    { topic: "two words" },
    { topic: "ok", server: "file:///tmp/x" },
    { topic: "ok", delayMinutes: -1 },
    { topic: "ok", delayMinutes: Infinity },
    { topic: "ok", mode: "sometimes" },
    { topic: "ok", username: "alice" },
    { topic: "ok", token: "" },
  ]) {
    assert.throws(() => validateConfig(value));
  }
});

test("persists and validates immediate notification mode", () => {
  assert.deepEqual(validateConfig({ topic: "alerts", mode: "immediate" }), {
    topic: "alerts",
    server: "https://ntfy.sh",
    delayMinutes: 15,
    mode: "immediate",
  });
});

test("finds the latest assistant response after the latest user message", () => {
  const response = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] };
  assert.equal(getLatestAssistantResponse([
    { type: "message", message: response },
    { type: "message", message: { role: "user", content: "Continue" } },
  ]), undefined);
  assert.equal(getLatestAssistantResponse([
    { type: "message", message: response },
    { type: "message", message: { role: "user", content: "Continue" } },
    { type: "message", message: response },
  ]), response);
});

test("detects ordinary completed assistant messages as awaiting user input", () => {
  assert.equal(isAwaitingUserInput({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "What do you think?" }] }), true);
});

test("does not classify tool handoffs or non-final assistant stops as user prompts", () => {
  assert.equal(isAwaitingUserInput({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash" }] }), false);
  assert.equal(isAwaitingUserInput({ role: "assistant", stopReason: "stop", content: [{ type: "toolCall", name: "bash" }] }), false);
  assert.equal(isAwaitingUserInput({ role: "assistant", stopReason: "error", content: [{ type: "text", text: "error" }] }), false);
  assert.equal(isAwaitingUserInput({ role: "user", stopReason: "stop", content: [] }), false);
  assert.equal(isAwaitingUserInput(undefined), false);
});

test("keyboard dismissal stays disarmed until an agent run completes", () => {
  const state = createAwaitingInputState();
  state.settle(true);
  assert.equal(state.shouldNotify(), true);

  state.dismiss();
  assert.equal(state.shouldNotify(), false);
  assert.equal(state.isWaiting(), true);

  state.beginAgentRun();
  assert.equal(state.shouldNotify(), false);
  assert.equal(state.isWaiting(), false);

  state.settle(true);
  assert.equal(state.shouldNotify(), true);
});

test("a non-waiting agent settlement clears the dismissed state", () => {
  const state = createAwaitingInputState();
  state.settle(true);
  state.dismiss();
  state.settle(false);
  assert.equal(state.shouldNotify(), false);
  assert.equal(state.isDismissed(), false);

  state.settle(true);
  assert.equal(state.shouldNotify(), true);
});

test("ending a UI prompt re-arms only when the agent is no longer waiting", () => {
  const state = createAwaitingInputState();
  state.beginUiPrompt();
  state.dismiss();
  state.endUiPrompt();
  assert.equal(state.isWaiting(), false);
  assert.equal(state.shouldNotify(), false);

  state.beginUiPrompt();
  state.dismiss();
  state.settle(true);
  state.endUiPrompt();
  assert.equal(state.isWaiting(), true);
  assert.equal(state.shouldNotify(), false);

  state.beginAgentRun();
  state.settle(true);
  assert.equal(state.shouldNotify(), true);
});
