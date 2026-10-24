// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import Ws from "ws";
import { OpenAILiveProvider } from "./live-provider.js";

class Socket extends EventEmitter {
  readyState = Ws.CONNECTING as number;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  terminate = vi.fn(() => {
    this.readyState = Ws.CLOSED;
    this.emit("close");
  });
  close = vi.fn(() => {
    this.readyState = Ws.CLOSED;
    this.emit("close");
  });
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  open() {
    this.readyState = Ws.OPEN;
    this.emit("open");
  }
  event(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}
function fixture(options: { response?: Response; timeoutMs?: number; manualOpen?: boolean } = {}) {
  const socket = new Socket();
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    if (String(_url).endsWith("/hangup"))
      return Promise.resolve(new Response(null, { status: 200 }));
    expect(init?.redirect).toBe("error");
    return Promise.resolve(
      options.response ??
        Response.json({
          session: { id: "live_example" },
          transport: { type: "webrtc", sdp: "answer" },
        }),
    );
  });
  const connect = vi.fn((_url: string, _options: Ws.ClientOptions) => {
    if (!options.manualOpen) queueMicrotask(() => socket.open());
    return socket as unknown as Ws;
  });
  const callbacks = { onEvent: vi.fn(), onFailure: vi.fn() };
  const provider = new OpenAILiveProvider({
    apiKey: "test-secret",
    fetch: fetcher,
    connect,
    timeoutMs: options.timeoutMs ?? 1000,
  });
  const start = (signal?: AbortSignal) =>
    provider.create({ sdp: "offer", instructions: "Delegate work.", signal }, callbacks);
  return { socket, fetcher, connect, callbacks, provider, start };
}

describe("OpenAILiveProvider", () => {
  it("creates server-owned client delegation and attaches before returning an answer", async () => {
    const f = fixture({ manualOpen: true });
    const pending = f.start();
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(f.socket.listenerCount("message")).toBe(1);
    expect(f.socket.listenerCount("error")).toBe(1);
    f.socket.open();
    const session = await pending;
    expect(session.sdp).toBe("answer");
    expect(f.connect.mock.calls[0][0]).toBe(
      "wss://api.openai.com/v1/live/sessions/live_example/attach",
    );
    const request = JSON.parse(f.fetcher.mock.calls[0][1]!.body as string);
    expect(request.session).toMatchObject({
      model: "gpt-live-1",
      delegation: { type: "client" },
      store: false,
      client: { data_channel: { allowed_client_events: [] } },
    });
    expect(request.session.audio.format).toBeUndefined();
    expect(request.session.client.data_channel.allowed_server_events).toEqual(
      [
        "session.started",
        "session.closed",
        "session.input_transcript.delta",
        "session.output_transcript.delta",
      ].map((type) => ({ type })),
    );
    expect(f.socket.sent).toEqual([]); // Attaching must never send session.start.
    f.socket.event({
      type: "session.delegation.created",
      delegation: { id: "del_example", target: "client" },
      offset_ms: 10,
    });
    expect(f.callbacks.onEvent).toHaveBeenCalledWith(expect.objectContaining({ offset_ms: 10 }));
    f.socket.event({ type: "session.input_audio.append", audio: "private-audio" });
    expect(f.callbacks.onEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "authentication_failed"],
    [403, "authentication_failed"],
    [404, "model_unavailable"],
    [429, "rate_limited"],
    [503, "provider_error"],
  ])("maps HTTP%s without exposing provider prose", async (status, code) => {
    const f = fixture({ response: new Response("PRIVATE_SENTINEL", { status: Number(status) }) });
    await expect(f.start()).rejects.toMatchObject({ detail: { code } });
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("preserves allowlisted quota code on rejected creation", async () => {
    const f = fixture({
      response: Response.json(
        { error: { code: "project_spend_limit_exceeded", message: "PRIVATE_SENTINEL" } },
        { status: 429 },
      ),
    });
    await expect(f.start()).rejects.toMatchObject({
      detail: { code: "project_spend_limit_exceeded", retryable: false },
    });
  });

  it("hangs up a created orphan when attachment fails", async () => {
    const f = fixture({ manualOpen: true });
    const pending = f.start();
    const rejection = expect(pending).rejects.toMatchObject({
      detail: { code: "connection_error" },
    });
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
    f.socket.emit("error", new Error("PRIVATE_SENTINEL"));
    await rejection;
    expect(f.fetcher.mock.calls[1][0]).toBe(
      "https://api.openai.com/v1/live/sessions/live_example/hangup",
    );
    expect(f.socket.terminate).toHaveBeenCalled();
  });

  it("preserves typed attachment HTTP rejection ahead of generic socket close", async () => {
    const f = fixture({ manualOpen: true });
    const pending = f.start();
    const rejection = expect(pending).rejects.toMatchObject({
      detail: { code: "quota_exhausted", retryable: false },
    });
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
    const response = Object.assign(new PassThrough(), { statusCode: 429 });
    f.socket.emit("unexpected-response", {}, response);
    f.socket.emit("error", new Error("PRIVATE_SENTINEL"));
    f.socket.emit("close");
    response.end(
      JSON.stringify({ error: { code: "insufficient_quota", message: "PRIVATE_SENTINEL" } }),
    );
    await rejection;
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.callbacks.onFailure).not.toHaveBeenCalled();
  });

  it("cleans up malformed answers that contain a known provider identity", async () => {
    const f = fixture({
      response: Response.json({
        session: { id: "live_example" },
        transport: { type: "webrtc", sdp: 10 },
      }),
    });
    await expect(f.start()).rejects.toMatchObject({ detail: { code: "protocol_error" } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts pending attachment and cleans up independently of the caller signal", async () => {
    const f = fixture({ manualOpen: true });
    const abort = new AbortController();
    const pending = f.start(abort.signal);
    const rejection = expect(pending).rejects.toMatchObject({ detail: { code: "timeout" } });
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
    abort.abort();
    await rejection;
    expect(f.fetcher.mock.calls[1][1]!.signal!.aborted).toBe(false);
  });

  it("bounds creation response bodies and rejects oversized caller SDP before I/O", async () => {
    const f = fixture({ response: new Response("x".repeat(130 * 1024)) });
    await expect(f.start()).rejects.toMatchObject({ detail: { code: "protocol_error" } });
    await expect(
      f.provider.create({ sdp: "x".repeat(65 * 1024), instructions: "" }, f.callbacks),
    ).rejects.toMatchObject({ detail: { code: "protocol_error" } });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("correlates append commands and confirms final cumulative usage before closing", async () => {
    const f = fixture();
    const session = await f.start();
    session.send({
      type: "session.commentary.append",
      event_id: "result_1",
      delegation_id: "del_example",
      content: "The task is complete.",
    });
    const closing = session.close();
    expect(session.close()).toBe(closing);
    expect(f.socket.terminate).not.toHaveBeenCalled();
    f.socket.event({ type: "session.usage.updated", usage: { seconds: 3 } });
    f.socket.event({ type: "session.closed", usage: { seconds: 4 } });
    await expect(closing).resolves.toEqual({ usageConfirmed: true, seconds: 4 });
    expect(f.callbacks.onEvent).toHaveBeenCalledWith({
      type: "session.closed",
      usage: { seconds: 4 },
    });
    expect(f.socket.sent.filter((e) => e.type === "session.close")).toHaveLength(1);
    expect(f.socket.terminate).toHaveBeenCalledOnce();
  });

  it("normalizes canonical assistant history to the documented output-text schema", async () => {
    const f = fixture();
    await f.provider.create(
      {
        sdp: "offer",
        instructions: "Delegate work.",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Find the workshop." }] },
          { role: "assistant", content: [{ type: "input_text", text: "Which workshop?" }] },
        ],
      },
      f.callbacks,
    );
    const request = JSON.parse(f.fetcher.mock.calls[0][1]!.body as string);
    expect(request.session.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Find the workshop." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Which workshop?" }],
      },
    ]);
  });

  it("bounds history and outgoing appends before sending provider commands", async () => {
    const f = fixture();
    await expect(
      f.provider.create(
        {
          sdp: "offer",
          instructions: "",
          input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(8193) }] }],
        },
        f.callbacks,
      ),
    ).rejects.toMatchObject({ detail: { code: "protocol_error" } });
    expect(f.fetcher).not.toHaveBeenCalled();
    const session = await f.start();
    expect(() =>
      session.send({
        type: "session.commentary.append",
        delegation_id: null,
        event_id: "too_large",
        content: "x".repeat(501),
      }),
    ).toThrow();
    expect(f.socket.sent).toHaveLength(0);
  });

  it("reports incomplete finalization despite a successful REST fallback", async () => {
    const f = fixture({ timeoutMs: 10 });
    const session = await f.start();
    await expect(session.close()).resolves.toEqual({ usageConfirmed: false, seconds: undefined });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.socket.terminate).toHaveBeenCalledOnce();
  });

  it("does not expose malformed frames or socket exception text", async () => {
    const f = fixture();
    await f.start();
    f.socket.emit("message", Buffer.from("PRIVATE_SENTINEL"));
    f.socket.emit("error", new Error("PRIVATE_SENTINEL"));
    expect(f.callbacks.onFailure).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onFailure.mock.calls[0][0]).toMatchObject({ code: "protocol_error" });
    expect(JSON.stringify(f.callbacks.onFailure.mock.calls)).not.toContain("PRIVATE_SENTINEL");
  });
});
