// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal view from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createAgentClient: vi.fn(), getAgentModel: vi.fn() }));
vi.mock("../lib/agent-client.js", () => ({ createAgentClient: mocks.createAgentClient }));
vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getAgentModel: mocks.getAgentModel,
}));
// DOMPurify needs a real DOM; the transcript text itself is not under test.
vi.mock("../shared/agent-ui/markdown.js", () => ({
  renderMarkdown: (value) => `<p>${value}</p>`,
  renderCopyableMarkdown: (value) => ({ html: `<p>${value}</p>`, targets: [] }),
}));
import { AgentView } from "./agent.js";

import { clearPendingSubmission, readPendingSubmission } from "../lib/conversation-draft.js";

let sequence = 0;
let sid;
let host;
afterEach(() => {
  if (host) render(null, host);
  clearPendingSubmission(sid, readPendingSubmission(sid)?.clientMessageId);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open({ busy = false, saved = null, fresh = false } = {}) {
  sid = `send-race-session-${++sequence}`;
  vi.useFakeTimers();
  const { document, window } = parseHTML("<html><body><main></main></body></html>");
  Object.defineProperty(window, "location", { configurable: true, value: {
    pathname: fresh ? "/portal/agent" : `/portal/agent/${sid}`, href: `https://localhost/portal/agent/${sid}`,
  } });
  vi.stubGlobal("history", { replaceState: vi.fn((state, title, path) => { window.location.pathname = path; }) });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("Event", window.Event);
  vi.stubGlobal("CustomEvent", window.CustomEvent);
  const storage = new Map();
  if (saved) storage.set(`omnesis:conversation-draft:pending:${sid}`, JSON.stringify({ submission: saved }));
  vi.stubGlobal("localStorage", {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  });
  host = document.querySelector("main");
  let resolveSend, rejectSend, emit;
  const client = {
    getConfig: vi.fn().mockResolvedValue({ enabled: true, backend: "codex" }),
    createSession: vi.fn().mockResolvedValue({ sessionId: sid, model: "example-model", backend: "codex",
      messages: [{ role: "user", parts: [{ kind: "text", text: "Earlier prompt" }] }],
      messageCount: 1, busy, messagesAreVisible: true }),
    getControls: vi.fn().mockResolvedValue({ busy, queuedMessages: [] }),
    listConversations: vi.fn().mockResolvedValue({ conversations: [] }),
    onEvent: vi.fn((id, handler) => { emit = handler; return () => {}; }),
    onResync: vi.fn(() => () => {}),
    submitMessage: vi.fn(() => new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; })),
    close: vi.fn(),
  };
  mocks.createAgentClient.mockReturnValue(client);
  mocks.getAgentModel.mockResolvedValue({ configured: true, modelName: "Example model" });
  await act(async () => { render(h(AgentView, { convoId: fresh ? null : sid }), host); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  return { client, resolve: (value) => resolveSend(value), reject: (error) => rejectSend(error), emit: (event) => emit(event) };
}

async function send(label) {
  await act(async () => {
    const input = host.querySelector("textarea");
    input.value = "Explain the revised budget";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent.trim() === label);
    expect(button, host.textContent).toBeTruthy();
    button.closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("sent message presentation during controls polling", () => {
  it.each([false, true])("shows one message while its submission is in flight (busy=%s)", async (busy) => {
    const request = await open({ busy });
    await send(busy ? "Send follow-up" : "Send");
    expect(request.client.submitMessage).toHaveBeenCalledOnce();
    if (busy) request.client.getControls.mockResolvedValue({ busy, queuedMessages: [{ id: request.client.submitMessage.mock.calls[0][1].clientMessageId, text: "Explain the revised budget", status: "queued" }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(host.querySelector('[aria-label="Unconfirmed message"]')).toBeNull();
    // The composer still owns its draft until the HTTP response; count message surfaces only.
    expect(host.querySelectorAll('.agent-msg-user')).toHaveLength(2);
    await act(async () => { request.resolve({ submission: { status: "running" } }); });
  });

  it("keeps a queued controls snapshot from repeating an optimistic transcript bubble", async () => {
    const request = await open();
    await send("Send");
    const submission = request.client.submitMessage.mock.calls[0][1];
    request.client.getControls.mockResolvedValue({ busy: true, queuedMessages: [
      { id: submission.clientMessageId, text: submission.text, status: "queued" },
      { id: "other-device", text: submission.text, status: "queued" },
    ] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(host.querySelectorAll('.agent-msg-user')).toHaveLength(3);
    expect(host.querySelectorAll('[aria-label="Queued messages"]')).toHaveLength(1);
    expect(host.querySelector('[aria-label="Unconfirmed message"]')).toBeNull();
    await act(async () => { request.emit({ type: "agent.user.message", payload: {
      sessionId: sid, userMessageId: "durable-user", text: submission.text, submissionIds: [submission.clientMessageId],
    } }); });
    expect(host.querySelectorAll('.agent-msg-user')).toHaveLength(3);
    await act(async () => { request.resolve({ submission: { status: "running" } }); });
    expect(host.querySelectorAll('.agent-msg-user')).toHaveLength(3);
  });

  it("keeps a restored submission recoverable until retry, without repeating it during retry", async () => {
    const saved = { clientMessageId: "restored-submission", text: "Explain the revised budget", mode: "queue" };
    const request = await open({ saved });
    expect(host.querySelector('[aria-label="Unconfirmed message"]')).not.toBeNull();
    await act(async () => { host.querySelector('[aria-label="Unconfirmed message"] button').click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(request.client.submitMessage).toHaveBeenCalledWith(sid, saved);
    expect(host.querySelector('[aria-label="Unconfirmed message"]')).toBeNull();
    expect(host.querySelectorAll('.agent-msg-user')).toHaveLength(2);
    await act(async () => { request.resolve({ submission: { status: "running" } }); });
  });

  it("offers recovery after a network failure, and hides it during a retry", async () => {
    const request = await open();
    await send("Send");
    await act(async () => { request.reject(new Error("Connection lost")); await vi.advanceTimersByTimeAsync(0); });
    expect(host.querySelector('[aria-label="Unconfirmed message"]'), host.textContent).not.toBeNull();
    expect(host.querySelectorAll('.agent-msg-user')).toHaveLength(1);
    await act(async () => { host.querySelector('[aria-label="Unconfirmed message"] button').click(); });
    expect(host.querySelector('[aria-label="Unconfirmed message"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(host.querySelector('[aria-label="Unconfirmed message"]')).toBeNull();
    await act(async () => { request.resolve({ submission: { status: "running" } }); });
  });
});


describe("fresh conversation lifetime", () => {
  it("creates the session only on first send after an idle landing", async () => {
    const request = await open({ fresh: true });
    expect(host.querySelector("textarea").disabled).toBe(false);
    expect(request.client.createSession).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(45 * 60 * 1000); });
    expect(request.client.createSession).not.toHaveBeenCalled();
    expect(request.client.getControls).not.toHaveBeenCalled();
    await send("Send");
    expect(request.client.createSession).toHaveBeenCalledExactlyOnceWith({});
    expect(request.client.submitMessage).toHaveBeenCalledWith(sid, expect.objectContaining({ text: "Explain the revised budget" }));
    expect(window.location.pathname).toBe(`/portal/agent/${sid}`);
    expect(host.textContent).not.toContain("Conversation not found");
    await act(async () => { request.resolve({ submission: { status: "running" } }); });
  });

  it("retains the draft when session creation fails and retries on send", async () => {
    const request = await open({ fresh: true });
    request.client.createSession.mockRejectedValueOnce(new Error("Backend unavailable"));
    await send("Send");
    expect(request.client.submitMessage).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/portal/agent");
    expect(host.querySelector("textarea").value).toBe("Explain the revised budget");
    await send("Send");
    expect(request.client.createSession).toHaveBeenCalledTimes(2);
    expect(request.client.submitMessage).toHaveBeenCalledOnce();
    await act(async () => { request.resolve({ submission: { status: "running" } }); });
  });

  it("discards a delayed session activation after navigating to another conversation", async () => {
    const request = await open({ fresh: true });
    let complete;
    request.client.createSession.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await send("Send");
    await act(async () => { render(h(AgentView, { convoId: "another-conversation" }), host); });
    await act(async () => { complete({ sessionId: "abandoned-session", model: "example-model", backend: "codex" }); });
    expect(request.client.submitMessage).not.toHaveBeenCalled();
    expect(request.client.onEvent.mock.calls.some(([id]) => id === "abandoned-session")).toBe(false);
  });

  it("does not send after the chat view is closed during session creation", async () => {
    const request = await open({ fresh: true });
    let complete;
    request.client.createSession.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await send("Send");
    await act(async () => { render(null, host); });
    await act(async () => { complete({ sessionId: "abandoned-session", model: "example-model", backend: "codex" }); });
    expect(request.client.submitMessage).not.toHaveBeenCalled();
    expect(request.client.onEvent).not.toHaveBeenCalled();
  });

});

describe("controls polling", () => {
  function setHidden(hidden) {
    Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
    document.dispatchEvent(new window.Event("visibilitychange"));
  }

  it("stops polling a conversation whose controls are not found", async () => {
    const request = await open();
    request.client.getControls.mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const calls = request.client.getControls.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 2000); });
    expect(request.client.getControls).toHaveBeenCalledTimes(calls);
  });

  it("pauses while the tab is hidden and refreshes when it returns", async () => {
    const request = await open();
    const calls = request.client.getControls.mock.calls.length;
    await act(async () => { setHidden(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 2000); });
    expect(request.client.getControls).toHaveBeenCalledTimes(calls);
    await act(async () => { setHidden(false); });
    expect(request.client.getControls).toHaveBeenCalledTimes(calls + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(request.client.getControls).toHaveBeenCalledTimes(calls + 2);
  });
});
