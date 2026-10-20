// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toolInputJsonSchema, type ChatBackend, type ToolContext } from "@omnesis/agent";
import { AgentService } from "../agent/service.js";
import { FsConversationStore } from "../agent/conversation-store.js";
import { RealtimeService, realtimeBackend } from "./service.js";
import type WebSocket from "ws";
import type { OmnesisConfig } from "@omnesis/config";
import type { AgentEvent } from "@omnesis/core";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close = vi.fn();
  event(event: unknown) {
    this.emit("message", JSON.stringify(event));
  }
}
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => vi.stubEnv("OMNESIS_EXPERIMENTAL", "1"));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const config = (url = "https://api.openai.com"): OmnesisConfig => ({
  inference: {
    allowRemoteInference: true,
    entailment: { promptStyle: "judge" },
    backends: { cloud: { type: "http", url } },
  },
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-realtime-test-"));
  const store = new FsConversationStore(directory);
  const ordinary = {
    name: "text-fixture",
    model: "text-fixture",
    runTurn: vi.fn<ChatBackend["runTurn"]>().mockImplementation(async function* (input) {
      yield {
        type: "agent.text.delta",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          delta: "Ordinary text reply",
        },
      };
      yield {
        type: "agent.message.end",
        payload: { sessionId: input.sessionId, messageId: input.messageId, stopReason: "end_turn" },
      };
    }),
  } satisfies ChatBackend;
  const search = vi.fn(async (input: { query: string }) => ({
    query: input.query,
    durationMs: 1,
    results: [],
  }));
  const fetch = vi.fn(async () => null);
  const sql = vi.fn(async (query: string) => ({
    sql: query,
    columns: ["count"],
    rows: [[2]],
    rowCount: 1,
    truncated: false,
    durationMs: 1,
  }));
  const contexts: ToolContext[] = [];
  const customSchema = z.object({ value: z.string() });
  const customTool = {
    name: "fixture_write",
    description: "A fictional session-owned test tool",
    schema: customSchema,
    mutates: true,
    invoke: async (args: unknown, context: ToolContext) => {
      contexts.push(context);
      const parsed = customSchema.safeParse(args);
      return parsed.success
        ? { kind: "error" as const, code: "fixture", message: parsed.data.value }
        : { kind: "error" as const, code: "invalid_args", message: "invalid arguments" };
    },
  };
  const spend = vi.fn();
  const agent = new AgentService({
    backendFactory: () => ordinary,
    ports: { search: { search }, document: { fetch }, sql: { run: sql } },
    systemPrompt: "Shared core instructions: use evidence and preserve citations.",
    store,
    recordSpend: spend,
  });
  agent.setTaskToolsProvider(() => [customTool]);
  const socket = new Socket();
  const events: Array<Record<string, unknown>> = [];
  const canonical: AgentEvent[] = [];
  const unsubscribe = agent.subscribe("token:observer", (_seq, event) =>
    canonical.push(event as AgentEvent),
  );
  const peer = { send: (raw: string) => events.push(JSON.parse(raw)), close: vi.fn() };
  const authorized = vi.fn(() => true);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const usage = vi.fn();
  const service = new RealtimeService({
    getConfig: () => config(),
    getApiKey: () => "fixture-key",
    getAgent: () => agent,
    isAuthorized: authorized,
    connect: () => socket as unknown as WebSocket,
    logger,
    recordUsage: usage,
  });
  let connection: ReturnType<RealtimeService["open"]> | undefined;
  cleanups.push(async () => {
    connection?.close();
    service.dispose();
    unsubscribe();
    await agent.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    agent,
    store,
    ordinary,
    search,
    fetch,
    sql,
    contexts,
    customTool,
    spend,
    socket,
    events,
    canonical,
    peer,
    authorized,
    logger,
    usage,
    service,
    open: (conversationId?: string, version?: 1 | 2) => {
      connection = service.open(peer, "token:fixture", {
        token: "fixture-token",
        timeZone: "Europe/London",
        conversationId,
        version,
      });
      return connection;
    },
  };
}
async function ready(
  f: Awaited<ReturnType<typeof fixture>>,
  conversationId?: string,
  version?: 1 | 2,
) {
  const connection = f.open(conversationId, version);
  f.socket.emit("open");
  await vi.waitFor(() =>
    expect(f.socket.sent.some((event) => event.type === "session.update")).toBe(true),
  );
  f.socket.event({ type: "session.updated" });
  return connection;
}
async function speech(f: Awaited<ReturnType<typeof fixture>>, id = "r1", item = "speech-1") {
  const before = f.socket.sent.filter((event) => event.type === "response.create").length;
  f.socket.event({ type: "input_audio_buffer.committed", item_id: item });
  f.socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: item,
    transcript: "Find the fictional plant record",
  });
  await vi.waitFor(() =>
    expect(f.socket.sent.filter((event) => event.type === "response.create")).toHaveLength(
      before + 1,
    ),
  );
  f.socket.event({ type: "response.created", response: { id } });
}
function call(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  args: unknown,
  id: string,
  responseId = "r1",
) {
  f.socket.event({
    type: "response.function_call_arguments.done",
    response_id: responseId,
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  });
}
function done(f: Awaited<ReturnType<typeof fixture>>, id: string, status = "completed") {
  f.socket.event({
    type: "response.done",
    response: { id, status, output: [], usage: { input_tokens: 20, output_tokens: 10 } },
  });
}
async function settle(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(() =>
    expect(f.canonical.some((event) => event.type === "agent.message.end")).toBe(true),
  );
}

describe("direct realtime Omnesis runtime", () => {
  it("requires strict experimental mode, remote consent, real OpenAI origin and a key", () => {
    expect(realtimeBackend(config(), () => "key")).toBe("cloud");
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    vi.stubEnv("OMNESIS_SYNTHETIC", "1");
    expect(realtimeBackend(config(), () => "key")).toBeUndefined();
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    expect(
      realtimeBackend(config("https://api.openai.com.example.org"), () => "key"),
    ).toBeUndefined();
    expect(realtimeBackend(config(), () => undefined)).toBeUndefined();
    expect(
      realtimeBackend(
        { inference: { ...config().inference, allowRemoteInference: false } } as OmnesisConfig,
        () => "key",
      ),
    ).toBeUndefined();
  });
  it("accepts the echoed full session manifest above the client frame limit", async () => {
    const f = await fixture();
    f.open();
    f.socket.emit("open");
    await vi.waitFor(() =>
      expect(f.socket.sent.some((event) => event.type === "session.update")).toBe(true),
    );
    const echo = {
      type: "session.updated",
      session: { instructions: "x".repeat(80_000), tools: [{ description: "y".repeat(80_000) }] },
    };
    expect(Buffer.byteLength(JSON.stringify(echo))).toBeGreaterThan(128 * 1024);
    f.socket.event(echo);
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: "session.ready", protocolVersion: 1 }),
    );
    expect(f.peer.close).not.toHaveBeenCalled();
  });
  it("retains distinct bounded limits for incoming client frames and upstream events", async () => {
    const client = await fixture();
    const connection = await ready(client);
    connection.receive(
      JSON.stringify({ type: "input_audio_buffer.append", audio: "A".repeat(130 * 1024) }),
    );
    expect(client.peer.close).toHaveBeenCalled();
    const upstream = await fixture();
    await ready(upstream);
    upstream.socket.event({
      type: "session.updated",
      session: { instructions: "x".repeat(2 * 1024 * 1024) },
    });
    expect(upstream.peer.close).toHaveBeenCalled();
  });
  it.each([undefined, 2] as const)(
    "keeps missing-thread fallback exclusive to legacy clients (version %s)",
    async (version) => {
      const f = await fixture();
      f.open("missing-empty-thread", version);
      f.socket.emit("open");
      if (version === 2) {
        await vi.waitFor(() => expect(f.peer.close).toHaveBeenCalled());
        expect(f.socket.sent.some((event) => event.type === "session.update")).toBe(false);
        expect(f.events.some((event) => event.type === "session.ready")).toBe(false);
      } else {
        await vi.waitFor(() =>
          expect(f.socket.sent.some((event) => event.type === "session.update")).toBe(true),
        );
        f.socket.event({ type: "session.updated" });
        expect(f.events).toContainEqual(
          expect.objectContaining({ type: "session.ready", protocolVersion: 1 }),
        );
        expect(f.events.find((event) => event.type === "session.ready")?.conversationId).not.toBe(
          "missing-empty-thread",
        );
      }
    },
  );
  it.each([false, true])(
    "acknowledges graceful end only after text can resume, without waiting for persistence (active tool: %s)",
    async (activeTool) => {
      const f = await fixture();
      const connection = await ready(f, undefined, 2);
      const conversationId = f.events.find((event) => event.type === "session.ready")!
        .conversationId as string;
      let finishPersistence!: () => void;
      const pendingPersistence = new Promise<void>((resolve) => {
        finishPersistence = resolve;
      });
      const persistence = vi
        .spyOn(
          f.agent as unknown as {
            persistAndNotify: (sessionId: string, messageId?: string) => Promise<void>;
          },
          "persistAndNotify",
        )
        .mockReturnValue(pendingPersistence);
      let toolSignal: AbortSignal | undefined;
      if (activeTool) {
        vi.spyOn(f.customTool, "invoke").mockImplementation((_args, context) => {
          toolSignal = context.abortSignal;
          return new Promise((resolve) =>
            context.abortSignal?.addEventListener(
              "abort",
              () => resolve({ kind: "error", code: "turn_aborted", message: "Canceled" }),
              { once: true },
            ),
          );
        });
        await speech(f);
        call(f, "fixture_write", { value: "Fictional value" }, "pending-tool");
        await vi.waitFor(() => expect(toolSignal).toBeDefined());
      }
      connection.receive(JSON.stringify({ type: "session.end" }));
      connection.receive(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }));
      await vi.waitFor(() =>
        expect(f.events).toContainEqual({ type: "session.ended", conversationId }),
      );
      if (activeTool) expect(toolSignal?.aborted).toBe(true);
      expect(f.peer.close).toHaveBeenCalled();
      expect(f.socket.sent.some((event) => event.type === "session.end")).toBe(false);
      expect(() =>
        f.agent.sendMessage(
          "token:fixture",
          conversationId,
          "Immediate text after end acknowledgement",
        ),
      ).not.toThrow();
      finishPersistence();
      await vi.waitFor(() => expect(f.ordinary.runTurn).toHaveBeenCalledTimes(1));
      persistence.mockRestore();
    },
  );
  it("rejects graceful session end on legacy media transport", async () => {
    const f = await fixture();
    const connection = await ready(f);
    connection.receive(JSON.stringify({ type: "session.end" }));
    expect(f.peer.close).toHaveBeenCalled();
    expect(f.events.some((event) => event.type === "session.ended")).toBe(false);
  });
  it("keeps the call alive when barge-in cancels a voice start waiting on durable controls", async () => {
    const f = await fixture();
    const connection = await ready(f, undefined, 2);
    const conversationId = f.events.find((event) => event.type === "session.ready")!
      .conversationId as string;
    let persistStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      persistStarted = resolve;
    });
    let finishPersist!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finishPersist = resolve;
    });
    const originalSave = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementationOnce(async (record) => {
      persistStarted();
      await blocked;
      await originalSave(record);
    });
    const acceptance = f.agent.submitMessage("token:fixture", conversationId, {
      clientMessageId: "during-voice",
      text: "Queued text",
      mode: "queue",
    });
    await started;
    f.socket.event({ type: "input_audio_buffer.committed", item_id: "interrupted-audio" });
    f.socket.event({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "interrupted-audio",
      transcript: "Interrupted before admission",
    });
    f.socket.event({ type: "input_audio_buffer.speech_started" });
    f.socket.event({ type: "input_audio_buffer.committed", item_id: "replacement-audio" });
    f.socket.event({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "replacement-audio",
      transcript: "Replacement spoken question",
    });
    finishPersist();
    await acceptance;
    await vi.waitFor(() =>
      expect(f.socket.sent.filter((event) => event.type === "response.create")).toHaveLength(1),
    );
    expect(f.peer.close).not.toHaveBeenCalled();
    expect(
      f.canonical.some(
        (event) =>
          event.type === "agent.user.message" &&
          event.payload.text === "Interrupted before admission",
      ),
    ).toBe(false);
    expect(f.canonical).toContainEqual(
      expect.objectContaining({
        type: "agent.user.message",
        payload: expect.objectContaining({ text: "Replacement spoken question" }),
      }),
    );
    expect(f.ordinary.runTurn).not.toHaveBeenCalled();
    f.socket.event({ type: "response.created", response: { id: "replacement-response" } });
    done(f, "replacement-response");
    await settle(f);
    connection.receive(JSON.stringify({ type: "session.end" }));
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({ type: "session.ended", conversationId }),
    );
  });
  it("advertises additive direct-runtime capabilities while preserving the old available/model/audio contract", async () => {
    const f = await fixture();
    const capability = f.service.capability();
    expect(capability).toMatchObject({
      available: true,
      model: "gpt-realtime-2.1",
      audio: { format: "pcm16", sampleRate: 24000 },
      directAgentTools: true,
      canonicalAgentEvents: true,
      protocol: { min: 1, max: 2 },
    });
    const oldClient = JSON.parse(JSON.stringify(capability)) as {
      available: boolean;
      model: string;
    };
    expect(oldClient.available).toBe(true);
    expect(oldClient.model).toBe("gpt-realtime-2.1");
  });
  it("uses the complete normal interactive schemas and unchanged core prompt with a language-stable speech suffix", async () => {
    const f = await fixture();
    const ordinary = await f.agent.createSession("token:fixture", {
      profile: "interactive",
      caller: { kind: "operator" },
      timeZone: "Europe/London",
    });
    await ready(f, ordinary.sessionId);
    const configuration = f.socket.sent.find((event) => event.type === "session.update")
      ?.session as {
      tools: Array<{ name: string; parameters: unknown }>;
      instructions: string;
      audio: {
        input: {
          noise_reduction: { type: string };
          turn_detection: {
            type: string;
            create_response: boolean;
            interrupt_response: boolean;
            threshold: number;
          };
        };
      };
    };
    expect(configuration.tools.some((tool) => tool.name === "annotate_many")).toBe(true);
    expect(configuration.tools.some((tool) => tool.name === "run_sql")).toBe(true);
    expect(configuration.tools.find((tool) => tool.name === "fixture_write")?.parameters).toEqual(
      toolInputJsonSchema(f.customTool.schema),
    );
    expect(configuration.tools.some((tool) => tool.name === "ask_omnesis")).toBe(false);
    expect(
      configuration.instructions.startsWith(
        "Shared core instructions: use evidence and preserve citations.",
      ),
    ).toBe(true);
    expect(configuration.instructions).toContain("last clearly established language");
    expect(configuration.instructions).toContain("only on an explicit request");
    expect(configuration.audio.input.noise_reduction).toEqual({ type: "near_field" });
    expect(configuration.audio.input.turn_detection).toEqual({
      type: "server_vad",
      create_response: false,
      interrupt_response: false,
      threshold: 0.65,
    });
    expect(f.ordinary.runTurn).not.toHaveBeenCalled();
    expect(f.events.some((event) => event.type === "agent.event")).toBe(false);
  });
  it("executes actual search, fetch and SQL handles once, preserves batch cards on normal SSE and persists the tool transcript", async () => {
    const f = await fixture();
    await ready(f);
    await speech(f);
    call(f, "search_many", { queries: [{ query: "fern" }] }, "search-1");
    call(
      f,
      "fetch_many",
      { documents: [{ documentId: "11111111-1111-4111-8111-111111111111" }] },
      "fetch-1",
    );
    call(f, "run_sql", { sql: "SELECT 2 AS count" }, "sql-1");
    call(f, "search_many", { queries: [{ query: "fern" }] }, "search-1");
    done(f, "r1");
    await vi.waitFor(() =>
      expect(
        f.socket.sent.filter(
          (event) => (event.item as { type?: string } | undefined)?.type === "function_call_output",
        ),
      ).toHaveLength(3),
    );
    expect(f.search).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.sql).toHaveBeenCalledTimes(1);
    expect(f.canonical.some((event) => event.type === "agent.tool.child.start")).toBe(true);
    expect(f.canonical.some((event) => event.type === "agent.tool.child.result")).toBe(true);
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: "tool.start", name: "search_many" }),
    );
    f.socket.event({ type: "response.created", response: { id: "r2" } });
    f.socket.event({
      type: "response.output_audio_transcript.delta",
      response_id: "r2",
      delta: "The plant record is ready.",
    });
    done(f, "r2");
    await settle(f);
    await vi.waitFor(async () =>
      expect(
        (
          await f.store.load(
            f.events.find((event) => event.type === "session.ready")!.conversationId as string,
          )
        )?.messages.some((message) => message.parts.some((part) => part.kind === "tool_result")),
      ).toBe(true),
    );
    expect(f.ordinary.runTurn).not.toHaveBeenCalled();
    expect(f.spend).not.toHaveBeenCalled();
    expect(f.usage).toHaveBeenCalledTimes(2);
  });
  it("retains server-side argument validation and operator/timezone/abort ToolContext", async () => {
    const f = await fixture();
    await ready(f);
    await speech(f);
    call(f, "run_sql", { sql: 42 }, "bad");
    call(f, "fixture_write", { value: "fixture" }, "owned");
    done(f, "r1");
    await vi.waitFor(() => expect(f.contexts).toHaveLength(1));
    expect(f.sql).not.toHaveBeenCalled();
    expect(f.contexts[0]).toMatchObject({
      caller: { kind: "operator" },
      timeZone: "Europe/London",
    });
    expect(f.contexts[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(
      f.canonical.some(
        (event) =>
          event.type === "agent.tool.result" &&
          event.payload.result.kind === "error" &&
          event.payload.result.code === "invalid_args",
      ),
    ).toBe(true);
  });
  it("negotiates media-only audio sockets while canonical tool cards stay on ordinary SSE", async () => {
    const f = await fixture();
    f.open(undefined, 2);
    f.socket.emit("open");
    await vi.waitFor(() =>
      expect(f.socket.sent.some((event) => event.type === "session.update")).toBe(true),
    );
    f.socket.event({ type: "session.updated" });
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: "session.ready", protocolVersion: 2 }),
    );
    await speech(f);
    call(f, "run_sql", { sql: "SELECT 1" }, "sql-only-sse");
    done(f, "r1");
    await vi.waitFor(() =>
      expect(f.canonical.some((event) => event.type === "agent.tool.result")).toBe(true),
    );
    expect(
      f.events.some(
        (event) =>
          event.type === "tool.start" || event.type === "tool.end" || event.type === "agent.event",
      ),
    ).toBe(false);
  });
  it("revokes tool authority immediately before a provider function call", async () => {
    const f = await fixture();
    await ready(f);
    await speech(f);
    f.authorized.mockReturnValue(false);
    call(f, "run_sql", { sql: "SELECT 1" }, "revoked");
    expect(f.sql).not.toHaveBeenCalled();
    expect(f.peer.close).toHaveBeenCalled();
  });
  it("deduplicates ready/history and bounded private diagnostic events without forwarding diagnostics", async () => {
    const f = await fixture();
    const connection = await ready(f);
    f.socket.event({ type: "session.updated" });
    expect(f.events.filter((event) => event.type === "session.ready")).toHaveLength(1);
    const before = f.socket.sent.length;
    for (let rawBuffers = 0; rawBuffers < 20; rawBuffers++)
      connection.receive(
        JSON.stringify({
          type: "client.audio_diagnostics",
          stage: "ready",
          rawBuffers,
          pcmBuffers: 0,
          sentFrames: 0,
          engineRunning: true,
        }),
      );
    expect(f.socket.sent).toHaveLength(before);
    expect(
      f.logger.info.mock.calls.filter(([message]) => message.includes("client audio stage=")),
    ).toHaveLength(12);
    connection.receive(
      JSON.stringify({
        type: "client.audio_diagnostics",
        stage: "ready",
        rawBuffers: 0,
        pcmBuffers: 0,
        sentFrames: 0,
        engineRunning: true,
        transcript: "Private",
      }),
    );
    expect(f.peer.close).toHaveBeenCalled();
    expect(f.logger.info.mock.calls.join(" ")).not.toContain("Private");
  });
  it("keeps the call usable when the best-effort response usage ledger throws", async () => {
    const f = await fixture();
    await ready(f);
    f.usage.mockImplementation(() => {
      throw new Error("Ledger unavailable");
    });
    await speech(f);
    done(f, "r1");
    await settle(f);
    expect(f.peer.close).not.toHaveBeenCalled();
    expect(f.usage).toHaveBeenCalledTimes(1);
  });
  it("cancels an owned response once across repeated VAD and client cancellation, then continues the call", async () => {
    const f = await fixture();
    const connection = await ready(f);
    await speech(f);
    f.socket.event({ type: "input_audio_buffer.speech_started" });
    f.socket.event({ type: "input_audio_buffer.speech_started" });
    connection.receive(JSON.stringify({ type: "response.cancel" }));
    expect(f.socket.sent.filter((event) => event.type === "response.cancel")).toEqual([
      { type: "response.cancel", response_id: "r1" },
    ]);
    done(f, "r1", "cancelled");
    await settle(f);
    f.socket.event({ type: "error", error: { code: "response_cancel_not_active" } });
    f.socket.event({ type: "response.output_audio.delta", response_id: "r1", delta: "AAAA" });
    expect(f.peer.close).not.toHaveBeenCalled();
    await speech(f, "r2", "replacement-speech");
    done(f, "r1", "cancelled");
    f.socket.event({ type: "response.output_audio.delta", response_id: "r2", delta: "BBBB" });
    done(f, "r2");
    await vi.waitFor(() =>
      expect(f.canonical.filter((event) => event.type === "agent.message.end")).toHaveLength(2),
    );
    connection.receive(JSON.stringify({ type: "response.cancel" }));
    expect(f.socket.sent.filter((event) => event.type === "response.cancel")).toHaveLength(1);
    expect(f.events.filter((event) => event.type === "response.output_audio.delta")).toEqual([
      { type: "response.output_audio.delta", response_id: "r2", delta: "BBBB" },
    ]);
    expect(f.peer.close).not.toHaveBeenCalled();
    expect(
      f.canonical
        .filter((event) => event.type === "agent.message.end")
        .map((event) => event.payload.stopReason),
    ).toEqual(["canceled", "end_turn"]);
  });
  it("counts canceled response usage even after canonical turn cancellation and ignores stale response output", async () => {
    const f = await fixture();
    await ready(f);
    await speech(f);
    f.socket.event({ type: "input_audio_buffer.speech_started" });
    done(f, "r1", "cancelled");
    await settle(f);
    done(f, "r1", "cancelled");
    expect(f.usage).toHaveBeenCalledTimes(1);
    expect(f.ordinary.runTurn).not.toHaveBeenCalled();
    expect(
      f.canonical.some(
        (event) => event.type === "agent.message.end" && event.payload.stopReason === "canceled",
      ),
    ).toBe(true);
  });
  it("fails on transcription errors rather than leaving the conversation stuck", async () => {
    const f = await fixture();
    await ready(f);
    f.socket.event({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "speech-1",
    });
    expect(f.peer.close).toHaveBeenCalled();
    expect(f.ordinary.runTurn).not.toHaveBeenCalled();
  });
});
