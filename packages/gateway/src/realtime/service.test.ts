// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeService, realtimeBackend } from "./service.js";
import type WebSocket from "ws";
import type { OmnesisConfig } from "@omnesis/config";
import type { AgentService } from "../agent/service.js";

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
const config = (url = "https://api.openai.com") =>
  ({
    inference: { allowRemoteInference: true, backends: { cloud: { type: "http", url } } },
  }) as OmnesisConfig;
const connections: Array<ReturnType<RealtimeService["open"]>> = [];
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
});
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function fixture(turn?: AgentService["realtimeTurn"]) {
  const socket = new Socket();
  const events: Array<Record<string, unknown>> = [];
  const peer = { send: (data: string) => events.push(JSON.parse(data)), close: vi.fn() };
  const agent = {
    createSession: vi.fn().mockResolvedValue({ sessionId: "voice-thread" }),
    realtimeTurn: turn ?? vi.fn().mockResolvedValue("The ferns need water."),
  } as unknown as AgentService;
  const usage = vi.fn();
  const authorized = vi.fn(() => true);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = new RealtimeService({
    getConfig: () => config(),
    getApiKey: () => "test-key",
    getAgent: () => agent,
    isAuthorized: authorized,
    connect: () => socket as unknown as WebSocket,
    recordUsage: usage,
    logger,
  });
  const connection = service.open(peer, "token:fictional", {
    conversationId: "existing-thread",
    token: "fictional-token",
    timeZone: "Europe/London",
  });
  connections.push(connection);
  return { socket, events, peer, agent, service, connection, usage, authorized, logger };
}
async function ready(f: ReturnType<typeof fixture>) {
  f.socket.emit("open");
  await Promise.resolve();
  f.socket.event({ type: "session.updated" });
}
const call = (id = "call-1") => ({
  type: "response.function_call_arguments.done",
  name: "ask_omnesis",
  call_id: id,
  arguments: JSON.stringify({ question: "What needs watering?" }),
});

describe("realtime voice", () => {
  it("warns once when a ready call never sends microphone audio", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await ready(f);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no input audio received after 10 seconds"),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.peer.close).not.toHaveBeenCalled();
  });
  it("clears the missing-audio watchdog on call close", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await ready(f);
    f.connection.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(
      f.logger.info.mock.calls.filter(([message]) => message.includes("closed reason=")),
    ).toHaveLength(1);
  });
  it("logs bounded audio diagnostics without audio, transcript, credentials or provider messages", async () => {
    const f = fixture();
    await ready(f);
    const audio = Buffer.from("private-audio-test").toString("base64");
    f.connection.receive(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    f.connection.receive(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    f.socket.event({ type: "input_audio_buffer.speech_started" });
    f.socket.event({ type: "input_audio_buffer.speech_stopped" });
    f.socket.event({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Private transcript",
    });
    f.socket.event({
      type: "error",
      error: { code: "invalid_request_error", message: "Private upstream message test-key" },
    });
    const messages = [...f.logger.info.mock.calls, ...f.logger.warn.mock.calls]
      .map(([message]) => message)
      .join("\n");
    expect(
      f.logger.info.mock.calls.filter(([message]) => message.includes("first input audio")),
    ).toHaveLength(1);
    expect(messages).toContain(
      "audioFrames=2 audioBytes=36 forwardedFrames=2 speechStarts=1 speechStops=1",
    );
    expect(messages).toContain("upstream error code=invalid_request_error");
    for (const privateValue of [
      audio,
      "private-audio-test",
      "Private transcript",
      "Private upstream message",
      "test-key",
      "fictional-token",
    ])
      expect(messages).not.toContain(privateValue);
  });
  it("requires strict experimental mode, remote consent, real OpenAI origin and a key", () => {
    expect(realtimeBackend(config(), () => "key")).toBe("cloud");
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    vi.stubEnv("OMNESIS_SYNTHETIC", "1");
    expect(realtimeBackend(config(), () => "key")).toBeUndefined();
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    expect(
      realtimeBackend(config("https://api.openai.com.example.org"), () => "key"),
    ).toBeUndefined();
    expect(realtimeBackend(config("http://api.openai.com"), () => "key")).toBeUndefined();
    expect(realtimeBackend(config(), () => undefined)).toBeUndefined();
    expect(
      realtimeBackend(
        { inference: { ...config().inference, allowRemoteInference: false } } as OmnesisConfig,
        () => "key",
      ),
    ).toBeUndefined();
  });
  it("configures server-owned audio and tools, resumes the conversation and accepts only audio controls", async () => {
    const f = fixture();
    await ready(f);
    expect(f.agent.createSession).toHaveBeenCalledWith(
      "token:fictional",
      expect.objectContaining({
        resumeFromId: "existing-thread",
        profile: "voice",
        caller: { kind: "operator" },
      }),
    );
    expect(f.events).toContainEqual({
      type: "session.ready",
      conversationId: "voice-thread",
      model: "gpt-realtime",
    });
    expect(JSON.stringify(f.socket.sent)).not.toContain("test-key");
    f.connection.receive(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }));
    expect(f.socket.sent.at(-1)).toEqual({ type: "input_audio_buffer.append", audio: "AAAA" });
    f.connection.receive(
      JSON.stringify({ type: "session.update", session: { instructions: "replace" } }),
    );
    expect(f.peer.close).toHaveBeenCalled();
  });
  it("delegates once, streams actual tool cards and returns the result after response completion", async () => {
    const turn = vi
      .fn<AgentService["realtimeTurn"]>()
      .mockImplementation(async (_caller, _session, _text, _signal, onEvent) => {
        onEvent({
          type: "agent.tool.start",
          payload: {
            sessionId: "voice-thread",
            messageId: "message",
            toolCallId: "search-1",
            tool: "search_documents",
            args: {},
            argsSummary: "Plant care",
          },
        });
        return "The ferns need water.";
      });
    const f = fixture(turn);
    await ready(f);
    f.socket.event({ type: "response.created" });
    f.socket.event(call());
    f.socket.event(call());
    await Promise.resolve();
    expect(turn).toHaveBeenCalledTimes(1);
    expect(f.events).toContainEqual({
      type: "tool.start",
      id: "search-1",
      name: "search_documents",
      summary: "Plant care",
    });
    expect(f.socket.sent.filter((event) => event.type === "response.create")).toHaveLength(0);
    f.socket.event({
      type: "response.done",
      response: {
        id: "response-1",
        usage: { input_tokens: 20, output_tokens: 10, input_token_details: { cached_tokens: 5 } },
      },
    });
    expect(f.socket.sent.at(-1)).toEqual({ type: "response.create" });
    expect(f.usage).toHaveBeenCalledWith(
      { promptTokens: 20, completionTokens: 10, cacheReadTokens: 5 },
      "gpt-realtime",
    );
  });
  it("aborts delegated work when the phone disconnects and suppresses late output", async () => {
    let finish!: (value: string) => void;
    let signal: AbortSignal | undefined;
    const f = fixture(
      vi
        .fn<AgentService["realtimeTurn"]>()
        .mockImplementation((_caller, _session, _text, abort) => {
          signal = abort;
          return new Promise((resolve) => {
            finish = resolve;
          });
        }),
    );
    await ready(f);
    f.socket.event(call());
    f.connection.close();
    expect(signal?.aborted).toBe(true);
    const count = f.socket.sent.length;
    finish("Late answer");
    await Promise.resolve();
    expect(f.socket.sent).toHaveLength(count);
  });
  it("does not drop a call on redundant cancellation, but sanitizes provider failures", async () => {
    const f = fixture();
    await ready(f);
    f.socket.event({
      type: "error",
      error: { code: "response_cancel_not_active", message: "No response" },
    });
    expect(f.peer.close).not.toHaveBeenCalled();
    f.socket.event({ type: "error", error: { message: "private vendor error test-key" } });
    expect(f.peer.close).toHaveBeenCalled();
    expect(JSON.stringify(f.events)).not.toContain("test-key");
  });
  it("accounts for transcription usage separately and does not duplicate event samples", async () => {
    const f = fixture();
    await ready(f);
    const event = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "speech-1",
      transcript: "Water the ferns",
      usage: { type: "tokens", input_tokens: 8, output_tokens: 4 },
    };
    f.socket.event(event);
    f.socket.event(event);
    expect(f.usage).toHaveBeenCalledTimes(1);
    expect(f.usage).toHaveBeenCalledWith(
      { promptTokens: 8, completionTokens: 4 },
      "gpt-4o-mini-transcribe",
    );
  });
  it("closes established calls if experimental mode is disabled", async () => {
    const f = fixture();
    await ready(f);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    f.connection.receive(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }));
    expect(f.peer.close).toHaveBeenCalled();
  });
  it("rechecks credentials before delegating even without another audio frame", async () => {
    const f = fixture();
    await ready(f);
    f.authorized.mockReturnValue(false);
    f.socket.event(call());
    expect(f.agent.realtimeTurn).not.toHaveBeenCalled();
    expect(f.peer.close).toHaveBeenCalled();
  });
  it("keeps one conversation across successive spoken requests", async () => {
    const f = fixture();
    await ready(f);
    f.socket.event(call());
    await Promise.resolve();
    f.socket.event({ type: "response.done" });
    f.socket.event(call("call-2"));
    await Promise.resolve();
    expect(f.agent.realtimeTurn).toHaveBeenCalledTimes(2);
    expect(f.agent.createSession).toHaveBeenCalledTimes(1);
    expect(f.peer.close).not.toHaveBeenCalled();
  });
});
