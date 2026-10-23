// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childEventHooks, type ChatBackend, type TurnInput } from "@omnesis/agent";
import { LiveVoiceService } from "../realtime/live-service.js";
import { AgentService } from "./service.js";
import { FsConversationStore } from "./conversation-store.js";
import type {
  LiveProvider,
  LiveProviderCallbacks,
  LiveProviderCommand,
} from "../realtime/live-provider.js";
import type { AgentEvent } from "@omnesis/core";

const cleanups: Array<() => Promise<void>> = [];
const pendingGates: Array<() => void> = [];
afterEach(async () => {
  for (const resolve of pendingGates.splice(0)) resolve();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  pendingGates.push(resolve);
  return { promise, resolve };
}
async function* answer(input: TurnInput): AsyncIterable<AgentEvent> {
  const base = { sessionId: input.sessionId, messageId: input.messageId };
  yield { type: "agent.text.delta", payload: { ...base, delta: "Fictional verified answer" } };
  yield {
    type: "agent.message.end",
    payload: { ...base, stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } },
  };
}
async function fixture(run: ChatBackend["runTurn"] = answer) {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-configured-voice-"));
  const store = new FsConversationStore(directory);
  const inputs: TurnInput[] = [];
  const events: AgentEvent[] = [];
  const spend = vi.fn();
  const search = vi.fn(async (input: { query: string }) => ({
    query: input.query,
    results: [],
    durationMs: 1,
  }));
  const documentId = "11111111-1111-4111-8111-111111111111";
  const fetch = vi.fn(async () => ({
    ref: {
      documentId,
      sourceId: "fixture:workshop",
      sourceType: "fixture",
      title: "Fictional workshop guide",
    },
    document: { text: "The fictional workshop has two rooms." },
  }));
  const sql = vi.fn(async (query: string) => ({
    sql: query,
    columns: ["id", "rooms"],
    rows: [["room-1", 2]],
    rowIdentities: [
      {
        table: "fixture_rooms",
        recordKey: "room-1",
        primaryKeyColumns: [{ name: "id", value: "room-1" }],
      },
    ],
    rowCount: 1,
    truncated: false,
    durationMs: 1,
  }));
  const backend: ChatBackend = {
    name: "configured-backend",
    model: "configured-model",
    async *runTurn(input, signal) {
      inputs.push(input);
      yield* run(input, signal);
    },
  };
  const factory = vi.fn(() => backend);
  const service = new AgentService({
    backendFactory: factory,
    ports: {
      search: { search },
      document: { fetch },
      sql: { run: sql },
      record: {
        resolve: async ({ reference, snapshot }) => ({
          ...reference,
          title: "Fictional room count",
          keyFields: [{ label: "Rooms", value: 2 }],
          semanticTime: "2000-01-01T00:00:00Z",
          snapshot,
          sourceId: "fixture:workshop",
          sourceType: "fixture",
          tableDisplayName: "Workshop rooms",
          boundDocumentId: documentId,
        }),
      },
    },
    systemPrompt: "Exact ordinary core instructions",
    store,
    recordSpend: spend,
  });
  service.subscribe("token:observer", (_seq, event) => {
    events.push(event as AgentEvent);
  });
  cleanups.push(async () => {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, store, inputs, events, spend, factory, search, fetch, sql };
}
const submit = (clientMessageId: string, text = "Fictional workshop question") => ({
  clientMessageId,
  text,
});

async function* researchedAnswer(
  input: TurnInput,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  const base = { sessionId: input.sessionId, messageId: input.messageId };
  yield { type: "agent.text.delta", payload: { ...base, delta: "I will check." } };
  for (const [tool, args] of [
    ["search_many", { queries: [{ query: "fictional workshop" }] }],
    ["fetch_many", { documents: [{ documentId: "11111111-1111-4111-8111-111111111111" }] }],
    ["run_sql", { sql: "SELECT id, rooms FROM fixture_rooms" }],
    [
      "annotate_many",
      {
        annotations: [
          {
            documentId: "11111111-1111-4111-8111-111111111111",
            quote: "The fictional workshop has two rooms.",
          },
        ],
      },
    ],
    [
      "cite_record",
      {
        reference: {
          table: "fixture_rooms",
          recordKey: "room-1",
          primaryKeyColumns: [{ name: "id", value: "room-1" }],
        },
        snapshot: { id: "room-1", rooms: 2 },
      },
    ],
  ] as const) {
    const handle = input.tools.find((candidate) => candidate.name === tool)!;
    const toolCallId = `${input.messageId}-${tool}`;
    yield { type: "agent.tool.start", payload: { ...base, toolCallId, tool, args } };
    const child: AgentEvent[] = [];
    const result = await handle.invoke(args, {
      ...base,
      caller: input.caller,
      timeZone: input.timeZone,
      abortSignal: signal,
      ...childEventHooks({ ...base, toolCallId }, (event) => child.push(event)),
    });
    yield* child;
    yield {
      type: "agent.tool.result",
      payload: { ...base, toolCallId, result, durationMs: 1 },
    };
  }
  yield* answer(input);
}

describe("configured agent voice lease", () => {
  it("runs the configured model with ordinary prompt/tools/spend and keeps text/voice/text history", async () => {
    const f = await fixture();
    const created = await f.service.createSession("token:fixture", {
      caller: { kind: "operator" },
      timeZone: "Europe/London",
    });
    f.service.sendMessage("token:fixture", created.sessionId, "Initial text question");
    await vi.waitFor(() => expect(f.spend).toHaveBeenCalledTimes(1));
    const voice = await f.service.openVoiceSession("token:fixture", {
      conversationId: created.sessionId,
      timeZone: "Europe/London",
    });
    const result = await voice.submit(submit("voice-1"));
    expect(result).toMatchObject({ text: "Fictional verified answer", stopReason: "end_turn" });
    expect(voice).toMatchObject({
      sessionId: created.sessionId,
      model: "configured-model",
      backend: "configured-backend",
    });
    expect(f.inputs[1]?.systemPrompt).toBe(f.inputs[0]?.systemPrompt);
    expect(f.inputs[1]?.tools.map((tool) => tool.name)).toEqual(
      f.inputs[0]?.tools.map((tool) => tool.name),
    );
    expect(f.inputs[1]?.tools.some((tool) => tool.name === "annotate_many")).toBe(true);
    expect(f.inputs[1]?.caller).toEqual({ kind: "operator" });
    expect(f.inputs[1]?.timeZone).toBe("Europe/London");
    expect(f.spend).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelId: "configured-model", completed: true }),
    );
    await voice.close();
    f.service.sendMessage("token:fixture", created.sessionId, "Next text question");
    await vi.waitFor(() => expect(f.inputs).toHaveLength(3));
    expect(
      f.inputs[2]?.history.some((message) =>
        message.parts.some(
          (part) => part.kind === "text" && part.text === "Fictional workshop question",
        ),
      ),
    ).toBe(true);
    const stored = await f.store.load(created.sessionId);
    expect(stored).toMatchObject({ model: "configured-model", backend: "configured-backend" });
  });
  it("keeps result and event observers attached across a pending interactive profile swap", async () => {
    const gate = deferred();
    const f = await fixture(async function* (input) {
      if (input.userMessage === "Held typed question") await gate.promise;
      yield* answer(input);
    });
    const initial = await f.service.createSession("token:fixture", { profile: "voice" });
    f.service.sendMessage("token:fixture", initial.sessionId, "Held typed question");
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    const voice = await f.service.openVoiceSession("token:fixture", {
      conversationId: initial.sessionId,
    });
    const observed: AgentEvent[] = [];
    voice.subscribe((event) => observed.push(event));
    const result = voice.submit(submit("after-swap"));
    gate.resolve();
    const completed = await result;
    expect(completed.text).toBe("Fictional verified answer");
    expect(f.inputs[1]?.tools.some((tool) => tool.name === "annotate_many")).toBe(true);
    expect(observed).toContainEqual(
      expect.objectContaining({
        type: "agent.message.end",
        payload: expect.objectContaining({ messageId: completed.messageId }),
      }),
    );
  });
  it("excludes hidden watch seeds from frontend context while retaining them for configured research", async () => {
    const f = await fixture();
    await f.store.save({
      id: "fixture-watch-thread",
      callerId: "token:fixture",
      model: "configured-model",
      backend: "configured-backend",
      title: "Fictional watch",
      pinned: false,
      createdAt: "2000-01-01T00:00:00Z",
      updatedAt: "2000-01-01T00:00:00Z",
      origin: {
        kind: "watch_firing",
        firingId: "fixture-firing",
        runId: "fixture-firing",
        watchId: "fixture-watch",
        seedMessageCount: 2,
      },
      messages: [
        { role: "user", parts: [{ kind: "text", text: "HIDDEN_FIXTURE_SEED" }] },
        { role: "assistant", parts: [{ kind: "text", text: "HIDDEN_FIXTURE_RESULT" }] },
        { role: "user", parts: [{ kind: "text", text: "Visible fictional question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Visible fictional answer" }] },
      ],
    });
    const voice = await f.service.openVoiceSession("token:fixture", {
      conversationId: "fixture-watch-thread",
    });
    expect(JSON.stringify(voice.history)).toContain("HIDDEN_FIXTURE_SEED");
    expect(JSON.stringify(voice.visibleHistory)).not.toContain("HIDDEN_FIXTURE");
    expect(JSON.stringify(voice.visibleHistory)).toContain("Visible fictional answer");
    await voice.submit(submit("visible-followup"));
    expect(JSON.stringify(f.inputs[0]?.history)).toContain("HIDDEN_FIXTURE_SEED");
  });
  it("runs text to GPT-Live delegation with real tools/citations and returns to text on one configured session", async () => {
    const f = await fixture(async function* (input, signal) {
      if (input.userMessage.startsWith("Fictional voice request"))
        yield* researchedAnswer(input, signal);
      else yield* answer(input);
    });
    const initial = await f.service.createSession("token:fixture");
    f.service.sendMessage("token:fixture", initial.sessionId, "Initial typed request");
    await vi.waitFor(() => expect(f.spend).toHaveBeenCalledOnce());
    let callbacks: LiveProviderCallbacks | undefined;
    const sent: LiveProviderCommand[] = [];
    const provider: LiveProvider = {
      create: async (_input, hooks) => {
        callbacks = hooks;
        return {
          id: "private-fixture-provider-id",
          sdp: "fixture-sdp-answer",
          send: (command) => {
            sent.push(command);
          },
          close: async () => ({ usageConfirmed: true, seconds: 3 }),
        };
      },
    };
    const live = new LiveVoiceService({
      backend: () => "fixture-openai",
      getApiKey: () => "fixture-key",
      getAgent: () => f.service,
      isAuthorized: () => true,
      hasCapacity: () => true,
      provider: () => provider,
      warn: () => {},
    });
    cleanups.unshift(async () => {
      await live.dispose();
    });
    const answer = await live.create("token:fixture", "fixture-token", {
      sdp: "fixture-offer",
      clientSessionId: "22222222-2222-4222-8222-222222222222",
      conversationId: initial.sessionId,
    });
    expect(answer).toMatchObject({
      conversationId: initial.sessionId,
      model: "configured-model",
      backend: "configured-backend",
    });
    live.ready("token:fixture", "fixture-token", answer.id);
    callbacks?.onEvent({
      type: "session.input_transcript.delta",
      event_id: "fixture-input",
      delta: "Fictional voice request",
      start_ms: 0,
      end_ms: 100,
    });
    callbacks?.onEvent({
      type: "session.delegation.created",
      offset_ms: 100,
      delegation: { id: "fixture-delegation", target: "client" },
    });
    await vi.waitFor(() =>
      expect(sent.some((command) => command.type === "session.commentary.append")).toBe(true),
    );
    expect(
      sent
        .filter((command) => command.type === "session.commentary.append")
        .map((command) => command.content)
        .join(" "),
    ).toContain("Fictional verified answer");
    expect(f.inputs).toHaveLength(2);
    expect(f.events.some((event) => event.type === "agent.citation")).toBe(true);
    expect(await live.end("token:fixture", "fixture-token", answer.id)).toMatchObject({
      ended: true,
      usageConfirmed: true,
    });
    f.service.sendMessage("token:fixture", initial.sessionId, "Back to typed request");
    await vi.waitFor(() => expect(f.inputs).toHaveLength(3));
    expect(
      f.inputs[2]?.history.some((message) =>
        message.parts.some(
          (part) => part.kind === "tool_result" && part.result.kind === "annotate.batch",
        ),
      ),
    ).toBe(true);
    expect(
      f.inputs[2]?.history.some((message) =>
        message.parts.some(
          (part) => part.kind === "tool_result" && part.result.kind === "cite_record.recorded",
        ),
      ),
    ).toBe(true);
  });
  it("returns duplicate receipts without rerunning, including after durable reopen", async () => {
    const f = await fixture();
    const voice = await f.service.openVoiceSession("token:fixture");
    const [first, duplicate] = await Promise.all([
      voice.submit(submit("same")),
      voice.submit(submit("same")),
    ]);
    expect(first).toEqual(duplicate);
    expect(f.inputs).toHaveLength(1);
    await voice.close();
    await f.service.dispose();
    const restarted = new AgentService({
      backendFactory: f.factory,
      ports: { search: { search: f.search }, document: { fetch: f.fetch }, sql: { run: f.sql } },
      systemPrompt: "Exact ordinary core instructions",
      store: f.store,
    });
    cleanups.unshift(async () => {
      await restarted.dispose();
    });
    const resumed = await restarted.openVoiceSession("token:fixture", {
      conversationId: voice.sessionId,
    });
    expect(await resumed.submit(submit("same"))).toEqual(first);
    expect(f.inputs).toHaveLength(1);
    const stored = await f.store.load(voice.sessionId);
    const receipt = stored?.controls?.submissions[0]?.result;
    expect(receipt).toMatchObject({ messageId: first.messageId, historyStart: 0 });
    expect(receipt).not.toHaveProperty("text");
    await expect(resumed.submit(submit("same", "Different fictional request"))).rejects.toThrow(
      "already used",
    );
  });
  it("coalesces durable corrections, keeps latest spoken context and detaches without cancellation", async () => {
    const gate = deferred();
    const signals: Array<AbortSignal | undefined> = [];
    const f = await fixture(async function* (input, signal) {
      signals.push(signal);
      if (input.userMessage.startsWith("First")) await gate.promise;
      yield* answer(input);
    });
    const voice = await f.service.openVoiceSession("token:fixture");
    const first = voice.submit(submit("first", "First fictional request"));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    const second = voice.submit({
      ...submit("second", "Second fictional request"),
      spokenContext: "Earlier fictional caption",
    });
    const third = voice.submit({
      ...submit("third", "Corrected fictional request"),
      spokenContext: "Latest fictional caption",
    });
    await vi.waitFor(() =>
      expect(f.service.conversationControls(voice.sessionId).queuedMessages).toHaveLength(2),
    );
    await voice.close();
    expect(signals[0]?.aborted).toBe(false);
    gate.resolve();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a.messageId).not.toBe(b.messageId);
    expect(b.messageId).toBe(c.messageId);
    expect(f.inputs).toHaveLength(2);
    expect(f.inputs[1]?.userMessage).toContain(
      "Second fictional request\n\nCorrected fictional request",
    );
    expect(f.inputs[1]?.modelNote).toContain("Latest fictional caption");
    expect(f.inputs[1]?.modelNote).not.toContain("Earlier fictional caption");
    expect(f.inputs[1]?.modelNote).toContain("Untrusted voice transcript context");
    const stored = await f.store.load(voice.sessionId);
    expect(stored?.messages.filter((message) => message.role === "user").at(-1)?.parts).toEqual([
      { kind: "text", text: "Second fictional request\n\nCorrected fictional request" },
    ]);
  });
  it("does not resolve a result before its receipt and canonical answer persist", async () => {
    const f = await fixture();
    const voice = await f.service.openVoiceSession("token:fixture");
    const gate = deferred();
    const saved = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementation(async (record) => {
      if (record.controls?.submissions.some((item) => item.result)) await gate.promise;
      await saved(record);
    });
    let resolved = false;
    const result = voice.submit(submit("persisted")).then((value) => {
      resolved = true;
      return value;
    });
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.type === "agent.message.end")).toBe(true),
    );
    expect(resolved).toBe(false);
    gate.resolve();
    expect(await result).toMatchObject({ text: "Fictional verified answer" });
    expect((await f.store.load(voice.sessionId))?.controls?.submissions[0]?.result).toBeDefined();
  });
  it("keeps canonical tools and batch child events rather than adding delegation cards", async () => {
    const f = await fixture(researchedAnswer);
    const voice = await f.service.openVoiceSession("token:fixture");
    const result = await voice.submit(submit("tools"));
    expect(result.text).toBe("Fictional verified answer");
    expect(f.search).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.sql).toHaveBeenCalledOnce();
    expect(f.events.some((event) => event.type === "agent.tool.child.start")).toBe(true);
    expect(
      f.events
        .filter((event) => event.type === "agent.tool.start")
        .map((event) => event.payload.tool),
    ).toEqual(["search_many", "fetch_many", "run_sql", "annotate_many", "cite_record"]);
    expect(
      (await f.store.load(voice.sessionId))?.messages.some((message) =>
        message.parts.some((part) => part.kind === "tool_result"),
      ),
    ).toBe(true);
    const stored = await f.store.load(voice.sessionId);
    expect(
      stored?.messages.some((message) =>
        message.parts.some(
          (part) => part.kind === "tool_result" && part.result.kind === "annotate.batch",
        ),
      ),
    ).toBe(true);
    expect(
      stored?.messages.some((message) =>
        message.parts.some(
          (part) => part.kind === "tool_result" && part.result.kind === "cite_record.recorded",
        ),
      ),
    ).toBe(true);
    expect(f.events.some((event) => event.type === "agent.citation")).toBe(true);
  });
  it("answers a durable clarification through ordinary tools without deadlocking the voice queue", async () => {
    const f = await fixture(async function* (input, signal) {
      if (input.userMessage === "Ask a fictional format") {
        const tool = input.tools.find((candidate) => candidate.name === "ask_clarification")!;
        const args = {
          question: "Which fictional format?",
          choices: [{ label: "Table" }, { label: "Prose" }],
        };
        const result = await tool.invoke(args, {
          sessionId: input.sessionId,
          messageId: input.messageId,
          caller: input.caller,
          abortSignal: signal,
        });
        yield {
          type: "agent.tool.start",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            toolCallId: "format",
            tool: tool.name,
            args,
          },
        };
        yield {
          type: "agent.tool.result",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            toolCallId: "format",
            result,
            durationMs: 1,
          },
        };
      }
      yield* answer(input);
    });
    const voice = await f.service.openVoiceSession("token:fixture");
    await voice.submit(submit("question", "Ask a fictional format"));
    expect(f.service.conversationControls(voice.sessionId).pendingClarification).toBeDefined();
    const reply = await voice.submit(submit("reply", "Table"));
    expect(reply.stopReason).toBe("end_turn");
    expect(f.service.conversationControls(voice.sessionId).pendingClarification).toBeUndefined();
    expect(await voice.submit(submit("reply", "Table"))).toEqual(reply);
    expect(f.inputs).toHaveLength(2);
  });
  it("does not accept late work from a detached lease waiting behind durable acceptance", async () => {
    const f = await fixture();
    const voice = await f.service.openVoiceSession("token:fixture");
    const gate = deferred();
    let blocked = false;
    const save = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementation(async (record) => {
      if (!blocked && record.controls?.submissions.some((item) => item.id === "portal")) {
        blocked = true;
        await gate.promise;
      }
      await save(record);
    });
    const portal = f.service.submitMessage("token:other", voice.sessionId, {
      ...submit("portal"),
      mode: "queue",
    });
    await vi.waitFor(() => expect(blocked).toBe(true));
    const late = voice.submit(submit("late"));
    const rejection = expect(late).rejects.toThrow("voice session ended");
    await voice.close();
    gate.resolve();
    await portal;
    await rejection;
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect(
      (await f.store.load(voice.sessionId))?.controls?.submissions.some(
        (item) => item.id === "late",
      ),
    ).toBe(false);
  });
  it("rejects a failed durable receipt without replaying the accepted model turn", async () => {
    const f = await fixture();
    const voice = await f.service.openVoiceSession("token:fixture");
    const save = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementation(async (record) => {
      if (record.controls?.submissions.some((item) => item.result))
        throw new Error("Fixture storage failure");
      await save(record);
    });
    await expect(voice.submit(submit("uncertain"))).rejects.toThrow("durably");
    await expect(voice.submit(submit("uncertain"))).rejects.toThrow("no recoverable result");
    expect(f.inputs).toHaveLength(1);
  });
  it("rechecks revoked authority inside queued admission and still permits owned cancellation", async () => {
    const f = await fixture(async function* (input, signal) {
      if (input.userMessage === "Held authorized request")
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      if (!signal?.aborted) yield* answer(input);
    });
    const authorized = vi.fn(() => true);
    const voice = await f.service.openVoiceSession("token:fixture", { authorized });
    const first = voice.submit(submit("authorized", "Held authorized request"));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    const second = voice.submit(submit("revoked-correction"));
    const stopped = expect(second).rejects.toThrow();
    await vi.waitFor(() =>
      expect(f.service.conversationControls(voice.sessionId).queuedMessages).toHaveLength(1),
    );
    authorized.mockReturnValue(false);
    await voice.cancel();
    expect(await first).toMatchObject({ stopReason: "canceled" });
    await stopped;
    await expect(voice.submit(submit("revoked-new"))).rejects.toThrow("voice call ended");
    await voice.close();
    expect(f.inputs).toHaveLength(1);
  });
  it("never claims cancellation ownership of a rejected conflicting receipt", async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const f = await fixture(async function* (input, abort) {
      signal = abort;
      await gate.promise;
      yield* answer(input);
    });
    const initial = await f.service.createSession("token:other");
    await f.service.submitMessage("token:other", initial.sessionId, {
      ...submit("portal-owned", "Original portal request"),
      mode: "queue",
    });
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    const voice = await f.service.openVoiceSession("token:fixture", {
      conversationId: initial.sessionId,
    });
    await expect(voice.submit(submit("portal-owned", "Conflicting voice request"))).rejects.toThrow(
      "already used",
    );
    await voice.cancel();
    expect(signal?.aborted).toBe(false);
    await voice.close();
    gate.resolve();
  });
  it("cancels queued voice work without canceling an unrelated active submission", async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const f = await fixture(async function* (input, abort) {
      signal = abort;
      await gate.promise;
      yield* answer(input);
    });
    const created = await f.service.createSession("token:other");
    await f.service.submitMessage("token:other", created.sessionId, {
      ...submit("portal"),
      mode: "queue",
    });
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    const voice = await f.service.openVoiceSession("token:fixture", {
      conversationId: created.sessionId,
    });
    const pending = voice.submit(submit("voice-correction"));
    const stopped = expect(pending).rejects.toThrow("durably");
    await vi.waitFor(() =>
      expect(f.service.conversationControls(voice.sessionId).queuedMessages).toHaveLength(1),
    );
    await voice.cancel();
    await stopped;
    await voice.close();
    expect(signal?.aborted).toBe(false);
    gate.resolve();
    await vi.waitFor(() =>
      expect(f.service.conversationControls(voice.sessionId).busy).toBe(false),
    );
    expect(f.inputs).toHaveLength(1);
    expect(
      (await f.store.load(voice.sessionId))?.controls?.submissions.find(
        (item) => item.id === "voice-correction",
      )?.status,
    ).toBe("failed");
  });
  it("stops an ID whose acceptance is in progress before it can enter the model queue", async () => {
    const f = await fixture();
    const voice = await f.service.openVoiceSession("token:fixture");
    const gate = deferred();
    const save = f.store.save.bind(f.store);
    let held = false;
    vi.spyOn(f.store, "save").mockImplementation(async (record) => {
      if (!held && record.controls?.submissions.some((item) => item.id === "accepting")) {
        held = true;
        await gate.promise;
      }
      await save(record);
    });
    const pending = voice.submit(submit("accepting"));
    const stopped = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(held).toBe(true));
    const cancel = voice.cancel();
    gate.resolve();
    await cancel;
    await stopped;
    await voice.close();
    expect(f.inputs).toHaveLength(0);
    expect((await f.store.load(voice.sessionId))?.controls?.submissions[0]?.status).toBe("failed");
  });
  it("cancels owned active work and durably stops its queued corrections", async () => {
    const f = await fixture(async function* (input, signal) {
      if (input.userMessage === "Held fictional request")
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      if (!signal?.aborted) yield* answer(input);
    });
    const voice = await f.service.openVoiceSession("token:fixture");
    const first = voice.submit(submit("held", "Held fictional request"));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    const second = voice.submit(submit("next"));
    await vi.waitFor(() =>
      expect(f.service.conversationControls(voice.sessionId).queuedMessages).toHaveLength(1),
    );
    const queuedCanceled = expect(second).rejects.toThrow("durably");
    await voice.cancel();
    expect(await first).toMatchObject({ stopReason: "canceled" });
    await queuedCanceled;
    expect(f.inputs).toHaveLength(1);
    expect(await voice.submit(submit("after-stop"))).toMatchObject({ stopReason: "end_turn" });
  });
});
