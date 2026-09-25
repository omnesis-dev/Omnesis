// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal client (`agent-client.js`) from
// vitest; the module is untyped browser code, so type-checking is off here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The client only imports `apiFetch` for its HTTP methods, which these tests
// don't touch — stub it so the module loads without the portal's fetch glue.
vi.mock("../api.js", () => ({ apiFetch: vi.fn() }));

import { createAgentClient } from "./agent-client.js";
import { apiFetch } from "../api.js";

/** Minimal in-process stand-in for the browser `EventSource`. */
class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  closed = false;
  // Mirrors the browser's persistent last-event-id buffer: only a frame's
  // `id:` updates it, and every message reports the retained value — so an
  // id-less frame (like agent.resync) carries the prior id, not "".
  private lastId = "";

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  /**
   * Deliver one SSE message. Pass `id` for a frame that carries an `id:`
   * line; omit it for an id-less frame, which reports the persisted last id
   * (faithful to real EventSource semantics).
   */
  emit(payload: unknown, id?: string) {
    if (id !== undefined && id !== "") this.lastId = id;
    this.onmessage?.({ data: JSON.stringify(payload), lastEventId: this.lastId });
  }

  /** Simulate a transport error so the client closes + schedules a reopen. */
  fail() {
    this.onerror?.({});
  }
}

describe("portal agent-client SSE resume", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  it("opens without ?since= on the first connection", () => {
    const client = createAgentClient();
    expect(MockEventSource.instances[0].url).toBe("/agent/events");
    client.close();
  });

  it("resumes past the last seen event id via ?since= on reconnect", () => {
    vi.useFakeTimers();
    const client = createAgentClient();
    const first = MockEventSource.instances[0];
    first.emit({ type: "agent.text.delta", payload: { sessionId: "s1", delta: "hi" } }, "5");
    first.fail(); // close + schedule reopen with backoff
    vi.advanceTimersByTime(2000); // past the jittered ~500ms backoff
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].url).toBe("/agent/events?since=5");
    client.close();
  });

  it("does not advance the resume cursor on the id-less resync frame", () => {
    vi.useFakeTimers();
    const client = createAgentClient();
    const first = MockEventSource.instances[0];
    first.emit({ type: "agent.text.delta", payload: { sessionId: "s1", delta: "x" } }, "7");
    // The id-less resync frame reports the persisted id "7" (real EventSource
    // carries it across frames); re-assigning the same value must not move the
    // cursor off 7.
    first.emit({ type: "agent.resync", payload: {} });
    first.fail();
    vi.advanceTimersByTime(2000);
    expect(MockEventSource.instances[1].url).toBe("/agent/events?since=7");
    client.close();
  });

  it("dispatches agent.resync (which carries no sessionId) to onResync handlers", () => {
    const client = createAgentClient();
    const first = MockEventSource.instances[0];
    const calls: number[] = [];
    const off = client.onResync(() => calls.push(1));

    first.emit({ type: "agent.resync", payload: {} });
    expect(calls).toEqual([1]);

    // A sessionId-less non-resync event is still ignored (no throw, no dispatch).
    first.emit({ type: "agent.text.delta", payload: {} });
    expect(calls).toEqual([1]);

    off();
    first.emit({ type: "agent.resync", payload: {} });
    expect(calls).toEqual([1]); // unsubscribed
    client.close();
  });

  it("routes session events to the matching onEvent listener", () => {
    const client = createAgentClient();
    const first = MockEventSource.instances[0];
    const seen: string[] = [];
    client.onEvent("s1", (msg) => seen.push(msg.type));

    first.emit({ type: "agent.text.delta", payload: { sessionId: "s1", delta: "a" } }, "1");
    first.emit({ type: "agent.text.delta", payload: { sessionId: "other", delta: "b" } }, "2");
    expect(seen).toEqual(["agent.text.delta"]);
    client.close();
  });

  it("buffers researcher events that arrive before a resumed session attaches", () => {
    const client = createAgentClient();
    const first = MockEventSource.instances[0];
    first.emit({ type: "agent.subagent.spawned", payload: { sessionId: "s-research", subagentId: "sub-1" } }, "1");
    first.emit({ type: "agent.subagent.event", payload: { sessionId: "s-research", subagentId: "sub-1" } }, "2");

    const seen: string[] = [];
    client.onEvent("s-research", (msg) => seen.push(msg.type));
    expect(seen).toEqual(["agent.subagent.spawned", "agent.subagent.event"]);
    client.close();
  });

  it("drops buffered events already represented by the resume snapshot cursor", () => {
    const client = createAgentClient();
    const first = MockEventSource.instances[0];
    first.emit(
      { type: "agent.text.delta", payload: { sessionId: "s-resume", delta: "in snapshot" } },
      "12",
    );
    first.emit(
      { type: "agent.text.delta", payload: { sessionId: "s-resume", delta: "after snapshot" } },
      "13",
    );

    const seen: string[] = [];
    client.onEvent("s-resume", (msg) => seen.push(msg.payload.delta), { afterEventId: 12 });

    expect(seen).toEqual(["after snapshot"]);
    client.close();
  });

  it("drops buffered derived events already represented by the server replay cursor", () => {
    const client = createAgentClient();
    const first = MockEventSource.instances[0];
    first.emit({
      type: "agent.tool.result",
      payload: {
        sessionId: "s-resume",
        toolCallId: "plan-1",
        result: { kind: "plan.updated", items: [{ id: "p1", status: "in_progress" }] },
      },
    }, "20");
    first.emit({
      type: "agent.tool.child.result",
      payload: { sessionId: "s-resume", toolCallId: "batch-1", childIndex: 0, result: { kind: "search.results", results: [] } },
    }, "21");

    const seen: string[] = [];
    client.onEvent("s-resume", (msg) => seen.push(msg.type), { afterEventId: 30 });

    expect(seen).toEqual([]);
    client.close();
  });

  it("compacts detached delta metadata and requests a new snapshot for an ambiguous suffix", () => {
    const client = createAgentClient();
    const first = MockEventSource.instances[0];
    for (let i = 1; i <= 700; i++) {
      first.emit({
        type: "agent.text.delta",
        payload: { sessionId: "s-bounded", messageId: "a-1", delta: String(i % 10) },
      }, String(i));
    }

    const seen: string[] = [];
    client.onEvent("s-bounded", (msg) => seen.push(msg.payload.delta), { afterEventId: 690 });
    expect(seen).toEqual([Array.from({ length: 10 }, (_, index) => String((index + 691) % 10)).join("")]);

    const second = createAgentClient();
    const secondSource = MockEventSource.instances.at(-1)!;
    for (let i = 1; i <= 700; i++) {
      secondSource.emit({
        type: "agent.text.delta",
        payload: { sessionId: "s-capped", messageId: "a-1", delta: "x" },
      }, String(i));
    }
    const capped: string[] = [];
    const onGap = vi.fn();
    // Cursor 100 intersects compacted range 1...189. That ambiguous range is
    // skipped, while the exact 190...700 suffix drains before reconciliation.
    second.onEvent("s-capped", (msg) => capped.push(msg.payload.delta), {
      afterEventId: 100,
      onGap,
    });
    expect(capped).toEqual(["x".repeat(511)]);
    expect(onGap).toHaveBeenCalledOnce();
    client.close();
    second.close();
  });

  it("requests a new snapshot when structural queue overflow crosses the cursor", () => {
    const client = createAgentClient();
    const first = MockEventSource.instances[0];
    for (let i = 1; i <= 130; i++) {
      first.emit({
        type: "agent.tool.child.result",
        payload: { sessionId: "s-overflow", childIndex: i },
      }, String(i));
    }

    const seen: number[] = [];
    const onGap = vi.fn();
    client.onEvent("s-overflow", (msg) => seen.push(msg.payload.childIndex), {
      afterEventId: 1,
      onGap,
    });

    expect(seen).toEqual(Array.from({ length: 128 }, (_, index) => index + 3));
    expect(onGap).toHaveBeenCalledOnce();
    client.close();
  });

  it("coalesces detached text without losing the live turn or subagent boundaries", () => {
    const client = createAgentClient();
    const first = MockEventSource.instances[0];
    first.emit({ type: "agent.message.start", payload: { sessionId: "s-live", messageId: "a-1" } });
    for (let i = 0; i < 300; i++) {
      first.emit({
        type: "agent.text.delta",
        payload: { sessionId: "s-live", messageId: "a-1", delta: "x" },
      });
    }
    first.emit({
      type: "agent.subagent.spawned",
      payload: { sessionId: "s-live", subagentId: "sub-1", specialist: "generic" },
    });
    first.emit({
      type: "agent.subagent.event",
      payload: {
        sessionId: "s-live",
        subagentId: "sub-1",
        event: { type: "agent.text.delta", payload: { delta: "discarded child prose" } },
      },
    });
    first.emit({
      type: "agent.subagent.event",
      payload: {
        sessionId: "s-live",
        subagentId: "sub-1",
        event: { type: "agent.usage.update", payload: { usage: { outputTokens: 12 } } },
      },
    });

    const seen: any[] = [];
    client.onEvent("s-live", (msg) => seen.push(msg));

    expect(seen.map((msg) => msg.type)).toEqual([
      "agent.message.start",
      "agent.text.delta",
      "agent.subagent.spawned",
      "agent.subagent.event",
    ]);
    expect(seen[1].payload.delta).toBe("x".repeat(300));
    expect(seen[3].payload.event.type).toBe("agent.usage.update");
    client.close();
  });
});

describe("portal agent-client sendMessage body", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
    (apiFetch as ReturnType<typeof vi.fn>).mockReset();
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ userMessageId: "m1" }),
    });
  });

  afterEach(() => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  function lastBody() {
    const calls = (apiFetch as ReturnType<typeof vi.fn>).mock.calls;
    const [, init] = calls[calls.length - 1];
    return JSON.parse(init.body);
  }

  it("sends an ordinary turn with no deepResearch by default", async () => {
    const client = createAgentClient();
    await client.sendMessage("s1", "what did I eat");
    expect(lastBody()).toEqual({ text: "what did I eat" });
    client.close();
  });

  it("folds deepResearch:true into the body when the pill is armed", async () => {
    const client = createAgentClient();
    await client.sendMessage("s1", "compare my running pace YoY", { deepResearch: true });
    expect(lastBody()).toEqual({ text: "compare my running pace YoY", deepResearch: true });
    client.close();
  });

  it("never forwards a falsy or stray option (explicit-only)", async () => {
    const client = createAgentClient();
    await client.sendMessage("s1", "plain", { deepResearch: false, bogus: 1 });
    expect(lastBody()).toEqual({ text: "plain" });
    client.close();
  });

  it("exposes the stable gateway error code on a rejected send", async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({
        code: "CONTEXT_WINDOW_EXCEEDED",
        error:
          "This conversation no longer fits in the selected model's context window. Start a new conversation to continue.",
      }),
    });
    const client = createAgentClient();

    await expect(client.sendMessage("s1", "one more question")).rejects.toMatchObject({
      status: 409,
      code: "CONTEXT_WINDOW_EXCEEDED",
    });
    client.close();
  });
});

describe("portal agent-client transcript pagination", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
    (apiFetch as ReturnType<typeof vi.fn>).mockReset();
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], pageInfo: { nextCursor: null } }),
    });
  });

  afterEach(() => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  it("requests a bounded transcript when resuming", async () => {
    const client = createAgentClient();
    await client.createSession({ resumeFromId: "session/one", transcriptLimit: 25 });
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/agent/sessions?transcriptLimit=25",
      expect.objectContaining({ method: "POST" }),
    );
    // The body is parsed rather than compared byte-for-byte: it also carries
    // the browser's zone, which is covered by its own suite below.
    const [, init] = (apiFetch as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(JSON.parse(init.body)).toMatchObject({
      resumeFromId: "session/one",
      profile: "interactive",
    });
    client.close();
  });

  it("loads an older message page with its opaque cursor", async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        messages: [{ id: "message-1" }],
        messagePageInfo: { nextCursor: "older" },
      }),
    });
    const client = createAgentClient();
    const page = await client.listConversationMessages("session/one", {
      limit: 25,
      cursor: "opaque cursor",
    });
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/agent/conversations/session%2Fone/messages?limit=25&cursor=opaque+cursor",
      { method: "GET" },
    );
    expect(page.items).toEqual([{ id: "message-1" }]);
    expect(page.pageInfo).toEqual({ nextCursor: "older" });
    client.close();
  });
});

describe("createSession — the browser's time zone", () => {
  /** The JSON body the client posted on its most recent createSession call. */
  function postedBody() {
    const [, init] = apiFetch.mock.calls.at(-1) ?? [];
    return JSON.parse(init.body);
  }

  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ sessionId: "S" }) });
  });

  afterEach(() => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  it("sends the browser's zone so the agent answers in the reader's clock", async () => {
    const client = createAgentClient();
    await client.createSession();

    expect(postedBody().timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(postedBody().profile).toBe("interactive");
  });

  it("still sends it alongside a resume", async () => {
    const client = createAgentClient();
    await client.createSession({ resumeFromId: "conv-1" });

    const body = postedBody();
    expect(body.resumeFromId).toBe("conv-1");
    expect(body.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("omits the key when the runtime resolves no zone", async () => {
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ timeZone: "" });
    try {
      const client = createAgentClient();
      await client.createSession();
      expect(postedBody()).not.toHaveProperty("timeZone");
    } finally {
      spy.mockRestore();
    }
  });
});
