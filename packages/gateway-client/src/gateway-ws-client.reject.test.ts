// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * sendCommand reject-path coverage for GatewayWsClient.
 *
 * The integration suite in `gateway-ws-client.test.ts` covers the happy
 * path (connect → hello → echo). These pin the three failure invariants
 * that keep the collector from hanging on a dead gateway:
 *   - sendCommand rejects "not connected / not authenticated" before auth,
 *   - a command the gateway never answers rejects "timed out" after
 *     commandTimeoutMs, and
 *   - onclose rejects every in-flight pending command with "WebSocket
 *     closed".
 *
 * A hand-driven fake WebSocket (stubbed onto the global) gives full
 * deterministic control over the open/auth/message/close lifecycle, and
 * fake timers fire the command timeout — no real sockets, no ports, no
 * wall-clock sleeps.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { makeResponseOk, websocketAuthProtocol, type WsCorrelationId } from "@omnesis/core";
import { GatewayWsClient } from "./gateway-ws-client.js";

const HELLO_RESPONSE = {
  deviceId: "dev-1",
  scopes: [] as string[],
  deviceName: "collector-alpha",
  deviceKind: "collector",
  protocolVersion: 1,
};

/**
 * Minimal driveable WebSocket. `connect()` assigns onopen/onmessage/
 * onclose/onerror after construction; the test fires them by hand so the
 * handshake is fully synchronous and deterministic.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static last: FakeWebSocket | null = null;

  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    FakeWebSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Test helper: deliver a server frame to the client. */
  deliver(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  /** Test helper: the id of the most-recently-sent command envelope. */
  lastSentId(): string {
    const last = this.sent[this.sent.length - 1];
    return JSON.parse(last).id as string;
  }
}

beforeEach(() => {
  FakeWebSocket.last = null;
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Connect + drive the hello handshake to an authenticated state. */
function connectAndAuth(): { client: GatewayWsClient; ws: FakeWebSocket } {
  const client = new GatewayWsClient("http://gw.example", "key");
  client.connect();
  const ws = FakeWebSocket.last!;
  expect(ws.protocols).toBe(websocketAuthProtocol("key"));
  // onopen triggers sendHello() → first send is the hello command.
  ws.onopen!();
  const helloId = ws.lastSentId();
  // A successful hello response flips `authenticated = true`.
  ws.deliver(makeResponseOk(helloId as WsCorrelationId, HELLO_RESPONSE));
  return { client, ws };
}

describe("GatewayWsClient.sendCommand reject paths", () => {
  test("rejects when called before the hello handshake authenticates", async () => {
    const client = new GatewayWsClient("http://gw.example", "key");
    client.connect();
    const ws = FakeWebSocket.last!;
    // Socket is open but hello has NOT been answered yet → not authenticated.
    ws.onopen!();

    await expect(client.sendCommand("source.discover", { descriptorId: "x" })).rejects.toThrow(
      /not connected \/ not authenticated/,
    );
  });

  test("rejects before connect() is ever called (no socket at all)", async () => {
    const client = new GatewayWsClient("http://gw.example", "key");
    await expect(client.sendCommand("source.discover", { descriptorId: "x" })).rejects.toThrow(
      /not connected \/ not authenticated/,
    );
  });

  test("rejects with a timeout error when the gateway never answers", async () => {
    vi.useFakeTimers();
    const { client, ws } = connectAndAuth();

    let outcome: { ok: boolean; message?: string } | null = null;
    const pending = client.sendCommand("source.discover", { descriptorId: "x" });
    const settled = pending.then(
      () => {
        outcome = { ok: true };
      },
      (e: Error) => {
        outcome = { ok: false, message: e.message };
      },
    );
    const commandId = ws.lastSentId();

    // Just under the 30s timeout: the timer has not fired, so the
    // command promise is still unsettled (`outcome` stays null even
    // after draining the microtask queue).
    await vi.advanceTimersByTimeAsync(29999);
    expect(outcome).toBeNull();

    // Cross the 30s deadline → reject.
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(outcome).not.toBeNull();
    expect(outcome!.ok).toBe(false);
    expect(outcome!.message).toMatch(/source\.discover timed out/);

    // A late response for the timed-out command must NOT throw (the
    // pending entry was deleted, so handleMessage drops it).
    expect(() =>
      ws.deliver(makeResponseOk(commandId as WsCorrelationId, { accounts: [] })),
    ).not.toThrow();
  });

  test("onclose rejects every in-flight command with 'WebSocket closed'", async () => {
    const { client, ws } = connectAndAuth();

    const a = client.sendCommand("source.discover", { descriptorId: "a" });
    const b = client.sendCommand("source.discover", { descriptorId: "b" });
    const aSettled = a.catch((e: Error) => e.message);
    const bSettled = b.catch((e: Error) => e.message);

    // Gateway drops the connection mid-flight.
    ws.onclose!();

    expect(await aSettled).toMatch(/WebSocket closed/);
    expect(await bSettled).toMatch(/WebSocket closed/);
  });

  test("forces a reconnect when gateway heartbeats stop", async () => {
    vi.useFakeTimers();
    const client = new GatewayWsClient("http://gw.example", "key", {
      reconnectDelay: 10,
      heartbeatTimeoutMs: 100,
    });
    client.connect();
    const ws = FakeWebSocket.last!;
    ws.onopen!();
    ws.deliver(makeResponseOk(ws.lastSentId() as WsCorrelationId, HELLO_RESPONSE));

    await vi.advanceTimersByTimeAsync(100);
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);

    await vi.advanceTimersByTimeAsync(10);
    expect(FakeWebSocket.last).not.toBe(ws);
  });

  test("retries a connection that never opens", async () => {
    vi.useFakeTimers();
    const client = new GatewayWsClient("http://gw.example", "key", {
      reconnectDelay: 10,
      heartbeatTimeoutMs: 100,
    });
    client.connect();
    const ws = FakeWebSocket.last!;

    await vi.advanceTimersByTimeAsync(100);
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);

    await vi.advanceTimersByTimeAsync(10);
    expect(FakeWebSocket.last).not.toBe(ws);
    client.disconnect();
  });

  test("gateway frames reset the heartbeat deadline", async () => {
    vi.useFakeTimers();
    const client = new GatewayWsClient("http://gw.example", "key", { heartbeatTimeoutMs: 100 });
    client.connect();
    const ws = FakeWebSocket.last!;
    ws.onopen!();
    ws.deliver(makeResponseOk(ws.lastSentId() as WsCorrelationId, HELLO_RESPONSE));

    await vi.advanceTimersByTimeAsync(99);
    ws.deliver({ kind: "event", type: "ping", payload: { t: 1 } });
    await vi.advanceTimersByTimeAsync(99);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);

    client.disconnect();
  });

  test("a response with an unknown correlationId is dropped without throwing", async () => {
    const { client, ws } = connectAndAuth();
    // No command in flight → no pending entry for this id. handleMessage
    // must silently drop it and the client must stay usable.
    expect(() =>
      ws.deliver(makeResponseOk("does-not-exist" as WsCorrelationId, { whatever: true })),
    ).not.toThrow();

    // Still authenticated: a fresh sendCommand schedules (doesn't reject).
    const inflight = client.sendCommand("source.discover", { descriptorId: "z" });
    const settled = inflight.catch((e: Error) => e.message);
    expect(ws.sent.length).toBeGreaterThan(1);
    // Close to clear the command timer and settle the pending promise.
    ws.onclose!();
    expect(await settled).toMatch(/WebSocket closed/);
  });

  test("invalid JSON and non-envelope frames are dropped without disturbing auth", async () => {
    const { client, ws } = connectAndAuth();

    expect(() => ws.onmessage!({ data: "}{not json" })).not.toThrow();
    expect(() => ws.onmessage!({ data: JSON.stringify({ hello: "world" }) })).not.toThrow();

    // The client remains authenticated: sendCommand schedules a send
    // rather than rejecting with "not authenticated".
    const inflight = client.sendCommand("source.discover", { descriptorId: "q" });
    const settled = inflight.catch((e: Error) => e.message);
    expect(ws.sent.length).toBeGreaterThan(1);
    // Close to clear the command timer and settle the pending promise.
    ws.onclose!();
    expect(await settled).toMatch(/WebSocket closed/);
  });
});
