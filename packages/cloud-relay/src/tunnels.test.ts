// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_TUNNEL_LIMITS, TunnelBroker } from "./tunnels.js";
import { validateTarget, rejectUpgrade } from "./server.js";
import type { IncomingMessage } from "node:http";

class Control extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  ping = vi.fn();
  close = vi.fn(() => {
    this.terminate();
  });
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
  send(message: string): void {
    this.sent.push(message);
  }
  get socket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

test("validates all admission limits and supports defaults", () => {
  new TunnelBroker().close();
  for (const key of Object.keys(DEFAULT_TUNNEL_LIMITS)) {
    for (const value of [0, -1, 0.5, NaN])
      expect(() => new TunnelBroker({ ...DEFAULT_TUNNEL_LIMITS, [key]: value })).toThrow(
        "positive",
      );
  }
});

test("aborted requests never reserve a channel and pending disconnects release admission", async () => {
  const broker = new TunnelBroker();
  const control = new Control();
  expect(() => broker.open("missing", new AbortController().signal)).toThrow("offline");
  broker.attach("account", control.socket, 3600);
  expect(() => broker.attach("account", new Control().socket, 3600)).toThrow("already connected");
  const aborted = new AbortController();
  aborted.abort();
  expect(() => broker.open("account", aborted.signal)).toThrow("disconnected");
  const controller = new AbortController();
  const pending = broker.open("account", controller.signal);
  const failure = expect(pending).rejects.toThrow("disconnected");
  controller.abort();
  await failure;
  control.readyState = WebSocket.CLOSING;
  expect(() => broker.open("account", new AbortController().signal)).toThrow("offline");
  control.readyState = WebSocket.OPEN;
  broker.close();
  expect(control.terminate).toHaveBeenCalled();
});

test("bounds per-gateway and global pending reservations separately", async () => {
  const broker = new TunnelBroker({
    ...DEFAULT_TUNNEL_LIMITS,
    maxStreams: 2,
    maxStreamsPerGateway: 1,
  });
  const a = new Control();
  const b = new Control();
  const c = new Control();
  broker.attach("a", a.socket, 3600);
  broker.attach("b", b.socket, 3600);
  broker.attach("c", c.socket, 3600);
  const pendingA = broker.open("a", new AbortController().signal);
  const rejectedA = expect(pendingA).rejects.toThrow("disconnected");
  expect(() => broker.open("a", new AbortController().signal)).toThrow("capacity");
  const pendingB = broker.open("b", new AbortController().signal);
  const rejectedB = expect(pendingB).rejects.toThrow("disconnected");
  expect(() => broker.open("c", new AbortController().signal)).toThrow("capacity");
  broker.close();
  await Promise.all([rejectedA, rejectedB]);
});

test("heartbeats require pong, contain socket errors, and end expired sessions", async () => {
  const broker = new TunnelBroker({ ...DEFAULT_TUNNEL_LIMITS, heartbeatMs: 100 });
  const control = new Control();
  broker.attach("account", control.socket, 3600);
  await vi.advanceTimersByTimeAsync(100);
  expect(control.ping).toHaveBeenCalledTimes(1);
  control.emit("pong");
  await vi.advanceTimersByTimeAsync(100);
  expect(control.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(control.terminate).toHaveBeenCalledTimes(1);
  const error = new Control();
  broker.attach("error", error.socket, 3600);
  error.emit("error", new Error("connection reset"));
  expect(error.terminate).toHaveBeenCalled();
  const expired = new Control();
  broker.attach("expired", expired.socket, -1);
  await vi.advanceTimersByTimeAsync(0);
  expect(expired.terminate).toHaveBeenCalled();
  const invalid = new Control();
  broker.attach("invalid", invalid.socket, 3600);
  invalid.emit("message", "bad");
  expect(invalid.close).toHaveBeenCalled();
  broker.close();
  expect(vi.getTimerCount()).toBe(0);
});

test("rejects invalid or stale data-channel claims", async () => {
  const broker = new TunnelBroker();
  const rejected = new Control();
  expect(broker.canClaim("missing", "missing")).toBe(false);
  broker.claim("missing", "missing", rejected.socket);
  expect(rejected.close).toHaveBeenCalledWith(1008, "Invalid data channel");
  broker.close();
});

test("only origin-form request targets are routable and upgrade rejections contain no payload", () => {
  for (const [url, method] of [
    [undefined, "GET"],
    ["https://attacker.example.test/", "GET"],
    ["//attacker.example.test/", "GET"],
    ["/", "CONNECT"],
  ]) {
    expect(() => validateTarget({ url, method } as IncomingMessage)).toThrow("Origin-form");
  }
  expect(() =>
    validateTarget({ url: "/mcp?query=one", method: "POST" } as IncomingMessage),
  ).not.toThrow();
  const socket = new PassThrough();
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  rejectUpgrade(socket, 401);
  expect(Buffer.concat(chunks).toString()).toContain(
    "401 Relay error\r\nConnection: close\r\nContent-Length: 0",
  );
});

test("a claimed channel contains peer errors and stale deadline callbacks are harmless", async () => {
  const timeout = vi.spyOn(globalThis, "setTimeout");
  const broker = new TunnelBroker();
  const control = new Control();
  broker.attach("account", control.socket, 3600);
  const controller = new AbortController();
  const pending = broker.open("account", controller.signal);
  const ticket = JSON.parse(control.sent.at(-1)!).ticket as string;
  const data = new Control();
  broker.claim("account", ticket, data.socket);
  const stream = await pending;
  expect(broker.canClaim("account", ticket)).toBe(false);
  stream.emit("error", new Error("peer failed"));
  await vi.advanceTimersByTimeAsync(0);
  expect(stream.destroyed).toBe(true);
  const aborted = broker.open("account", controller.signal);
  const failed = expect(aborted).rejects.toThrow("disconnected");
  const deadline = timeout.mock.calls.findLast(
    (call) => call[1] === DEFAULT_TUNNEL_LIMITS.connectTimeoutMs,
  )![0];
  controller.abort();
  await failed;
  expect(() => deadline()).not.toThrow();
  broker.close();
  timeout.mockRestore();
});

test("the open frame names the client's address in plain form, and nothing that is not an address", () => {
  const broker = new TunnelBroker();
  const control = new Control();
  broker.attach("account", control.socket, 3600);
  const frames = (client?: string) => {
    void broker.open("account", new AbortController().signal, client).catch(() => undefined);
    return JSON.parse(control.sent.at(-1)!) as Record<string, unknown>;
  };
  expect(frames("203.0.113.9").client).toBe("203.0.113.9");
  expect(frames("::ffff:203.0.113.9").client).toBe("203.0.113.9");
  expect(frames("2001:db8::7").client).toBe("2001:db8::7");
  expect(frames("::ffff:0:1").client).toBe("::ffff:0:1");
  expect(frames("not an address")).not.toHaveProperty("client");
  expect(frames(undefined)).not.toHaveProperty("client");
  broker.close();
});

test("a claimed channel is pinged while it is open, so an idle stream is not cut on the way", async () => {
  const broker = new TunnelBroker({ ...DEFAULT_TUNNEL_LIMITS, heartbeatMs: 100 });
  const control = new Control();
  broker.attach("account", control.socket, 3600);
  const pending = broker.open("account", new AbortController().signal);
  const data = new Control();
  broker.claim("account", JSON.parse(control.sent.at(-1)!).ticket as string, data.socket);
  const stream = await pending;
  await vi.advanceTimersByTimeAsync(100);
  control.emit("pong");
  await vi.advanceTimersByTimeAsync(100);
  expect(data.ping).toHaveBeenCalledTimes(2);
  stream.destroy();
  await vi.advanceTimersByTimeAsync(300);
  expect(data.ping).toHaveBeenCalledTimes(2);
  broker.close();
  expect(vi.getTimerCount()).toBe(0);
});
