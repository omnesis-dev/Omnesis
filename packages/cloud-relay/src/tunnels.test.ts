// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_TUNNEL_LIMITS, TunnelBroker } from "./tunnels.js";
import { CloudRelayMetrics } from "./metrics.js";
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

test("default admission fits browsers, native devices and reconnects sharing one address, while staying bounded", async () => {
  const broker = new TunnelBroker();
  const control = new Control();
  broker.attach("account", control.socket, 3600, true);
  const pending: Promise<unknown>[] = [];
  const reserve = (address: string) => {
    const controller = new AbortController();
    pending.push(broker.open("account", controller.signal, address).catch(() => undefined));
    return controller;
  };
  try {
    // Three browsers (six HTTP sockets each), two native devices, then a reconnect
    // burst while the old connections have not closed yet: one public NAT address.
    const existing = Array.from({ length: 20 }, () => reserve("192.0.2.1"));
    const reconnecting = Array.from({ length: 6 }, () => reserve("192.0.2.1"));
    expect(broker.snapshot().pendingStreams).toBe(26);
    existing.slice(0, 6).forEach((controller) => controller.abort());
    reconnecting.forEach((controller) => controller.abort());
    for (let i = 14; i < DEFAULT_TUNNEL_LIMITS.maxStreamsPerClientPerGateway; i++)
      reserve("192.0.2.1");
    expect(() => reserve("192.0.2.1")).toThrow("this client");
    // Another address can still connect, but represented clients stop at the
    // gateway's reserved quarter; entirely new clients retain the final slots.
    while (broker.snapshot().pendingStreams < 48) reserve("192.0.2.2");
    expect(() => reserve("192.0.2.2")).toThrow("capacity");
    for (let i = 0; i < 16; i++) reserve(`198.51.100.${i + 1}`);
    expect(broker.snapshot().pendingStreams).toBe(64);
    expect(() => reserve("203.0.113.1")).toThrow("capacity");
    expect(control.terminate).not.toHaveBeenCalled();
  } finally {
    broker.close();
    await Promise.all(pending);
  }
});

test("channel rejection is advertised only to a gateway that negotiated it", () => {
  const broker = new TunnelBroker();
  const oldGateway = new Control();
  const newGateway = new Control();
  broker.attach("old", oldGateway.socket, 3600);
  broker.attach("new", newGateway.socket, 3600, true);
  expect(JSON.parse(oldGateway.sent[0]!)).toEqual({
    type: "ready",
    version: 1,
    heartbeatMs: 30_000,
  });
  expect(JSON.parse(newGateway.sent[0]!)).toEqual({
    type: "ready",
    version: 1,
    heartbeatMs: 30_000,
    rejectChannels: true,
  });
  broker.close();
});

test("an older gateway keeps its sixteen-channel budget and eight-channel client share during rollout", async () => {
  const broker = new TunnelBroker();
  const control = new Control();
  broker.attach("legacy", control.socket, 3600);
  const pending: Promise<unknown>[] = [];
  const reserve = (address: string) =>
    pending.push(
      broker.open("legacy", new AbortController().signal, address).catch(() => undefined),
    );
  try {
    for (let i = 0; i < 8; i++) reserve("192.0.2.1");
    expect(() => reserve("192.0.2.1")).toThrow("this client");
    for (let i = 0; i < 4; i++) reserve("192.0.2.2");
    expect(() => reserve("192.0.2.2")).toThrow("capacity");
    for (let i = 0; i < 4; i++) reserve(`198.51.100.${i + 1}`);
    expect(broker.snapshot().pendingStreams).toBe(16);
    expect(() => reserve("203.0.113.1")).toThrow("capacity");
    expect(control.terminate).not.toHaveBeenCalled();
  } finally {
    broker.close();
    await Promise.all(pending);
  }
});

test("a negotiated refusal releases only that gateway's pending channel and leaves its control connected", async () => {
  const broker = new TunnelBroker({ ...DEFAULT_TUNNEL_LIMITS, maxStreamsPerGateway: 1 });
  const first = new Control();
  const second = new Control();
  broker.attach("first", first.socket, 3600, true);
  broker.attach("second", second.socket, 3600, true);
  const pending = broker.open("first", new AbortController().signal);
  const refused = expect(pending).rejects.toThrow("Gateway channel capacity reached");
  const ticket = JSON.parse(first.sent.at(-1)!).ticket as string;
  const rejection = JSON.stringify({ type: "reject", version: 1, ticket });
  second.emit("message", Buffer.from(rejection));
  expect(broker.snapshot().pendingStreams).toBe(1);
  first.emit("message", Buffer.from(rejection));
  await refused;
  expect(broker.snapshot().pendingStreams).toBe(0);
  // A duplicate refusal cannot affect an unrelated later reservation.
  const next = broker.open("first", new AbortController().signal).catch(() => undefined);
  first.emit("message", Buffer.from(rejection));
  expect(broker.snapshot().pendingStreams).toBe(1);
  expect(first.close).not.toHaveBeenCalled();
  expect(second.close).not.toHaveBeenCalled();
  broker.close();
  await next;
});

test.each([
  "not json",
  JSON.stringify({ type: "reject", version: 1, ticket: "invalid" }),
  JSON.stringify({ type: "reject", version: 1, ticket: "a".repeat(64), extra: true }),
])("invalid negotiated control input closes only its own gateway: %s", (input) => {
  const broker = new TunnelBroker();
  const first = new Control();
  const second = new Control();
  broker.attach("first", first.socket, 3600, true);
  broker.attach("second", second.socket, 3600, true);
  first.emit("message", Buffer.from(input));
  expect(first.close).toHaveBeenCalledWith(1008, "Unexpected control message");
  expect(second.close).not.toHaveBeenCalled();
  broker.close();
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

test("F16: each client's share of a gateway is reserved per /64 and returned when a stream ends", async () => {
  const broker = new TunnelBroker({ ...DEFAULT_TUNNEL_LIMITS, maxStreamsPerClientPerGateway: 1 });
  const control = new Control();
  broker.attach("a", control.socket, 3600);
  const first = new AbortController();
  const pending = broker.open("a", first.signal, "2001:db8:1:2::1");
  const failed = expect(pending).rejects.toThrow("disconnected");
  expect(() => broker.open("a", new AbortController().signal, "2001:db8:1:2::ff")).toThrow(
    "this client",
  );
  // Another client, and a caller with no address, are not counted against it.
  const other = broker.open("a", new AbortController().signal, "203.0.113.9");
  const unnamed = broker.open("a", new AbortController().signal);
  first.abort();
  await failed;
  const again = broker.open("a", new AbortController().signal, "2001:db8:1:2::2");
  broker.close();
  await Promise.all([other, unnamed, again].map((work) => work.catch(() => {})));
});

test("gateway fairness reserves new-client capacity without closing existing channels", async () => {
  const broker = new TunnelBroker({ ...DEFAULT_TUNNEL_LIMITS, maxStreamsPerGateway: 4 });
  const control = new Control();
  broker.attach("account", control.socket, 3600);
  const tasks: Promise<unknown>[] = [];
  const reserve = (address?: string) => {
    const abort = new AbortController();
    tasks.push(broker.open("account", abort.signal, address).catch(() => undefined));
    return abort;
  };
  const first = reserve("2001:db8:1:2::1");
  reserve("2001:db8:1:2::2");
  reserve();
  expect(() => broker.open("account", new AbortController().signal, "2001:db8:1:2::3")).toThrow(
    "capacity",
  );
  // Absent peer metadata is one existing client, not a new source for every request.
  expect(() => broker.open("account", new AbortController().signal)).toThrow("capacity");
  reserve("192.0.2.7");
  expect(broker.snapshot().pendingStreams).toBe(4);
  expect(() => broker.open("account", new AbortController().signal, "192.0.2.8")).toThrow(
    "capacity",
  );
  expect(control.terminate).not.toHaveBeenCalled();
  first.abort();
  expect(broker.snapshot().pendingStreams).toBe(3);
  // Remaining reservations still account for their sources after an abort.
  expect(() => broker.open("account", new AbortController().signal, "2001:db8:1:2::4")).toThrow(
    "capacity",
  );
  reserve("192.0.2.8");
  broker.close();
  await Promise.all(tasks);
  expect(broker.snapshot().pendingStreams).toBe(0);
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

test("a gateway is online only while its tunnel is open, and closing its account takes it offline at once", () => {
  const broker = new TunnelBroker();
  const control = new Control();
  expect(broker.online("account")).toBe(false);
  broker.attach("account", control.socket, 3600);
  expect(broker.online("account")).toBe(true);
  expect(broker.online("other")).toBe(false);
  // A tunnel that is closing carries nothing, so it doesn't count.
  control.readyState = WebSocket.CLOSING;
  expect(broker.online("account")).toBe(false);
  control.readyState = WebSocket.OPEN;
  broker.closeAccount("account");
  expect(control.terminate).toHaveBeenCalled();
  expect(broker.online("account")).toBe(false);
  // Back again, it is online again.
  const again = new Control();
  broker.attach("account", again.socket, 3600);
  expect(broker.online("account")).toBe(true);
  again.emit("close");
  expect(broker.online("account")).toBe(false);
  broker.close();
});

function sendRenewal(control: Control, session = "fictional-routing-session"): void {
  control.emit("message", Buffer.from(JSON.stringify({ type: "renew", version: 1, session })));
}

test("renewal is optional and independent of channel rejection in the ready frame", () => {
  const broker = new TunnelBroker();
  const legacy = new Control();
  const renewal = new Control();
  const both = new Control();
  broker.attach("legacy", legacy.socket, 2);
  broker.attach("renewal", renewal.socket, 2, false, async () => 4);
  broker.attach("both", both.socket, 2, true, async () => 4);
  expect(JSON.parse(legacy.sent[0]!)).toEqual({ type: "ready", version: 1, heartbeatMs: 30_000 });
  expect(JSON.parse(renewal.sent[0]!)).toEqual({
    type: "ready",
    version: 1,
    heartbeatMs: 30_000,
    sessionExpiresAt: 2,
  });
  expect(JSON.parse(both.sent[0]!)).toEqual({
    type: "ready",
    version: 1,
    heartbeatMs: 30_000,
    rejectChannels: true,
    sessionExpiresAt: 2,
  });
  broker.close();
});

test("multiple authenticated renewals retain active streams and pending channels across the original deadline", async () => {
  const broker = new TunnelBroker();
  const control = new Control();
  const verify = vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(6);
  broker.attach("account", control.socket, 2, true, verify);
  const firstPending = broker.open("account", new AbortController().signal);
  broker.claim("account", JSON.parse(control.sent.at(-1)!).ticket as string, new Control().socket);
  const firstStream = await firstPending;
  const secondPending = broker.open("account", new AbortController().signal);
  void secondPending.catch(() => {});
  const secondTicket = JSON.parse(control.sent.at(-1)!).ticket as string;
  try {
    await vi.advanceTimersByTimeAsync(1000);
    sendRenewal(control, "fictional-session-one");
    await vi.advanceTimersByTimeAsync(0);
    expect(verify).toHaveBeenLastCalledWith("fictional-session-one");
    expect(JSON.parse(control.sent.at(-1)!)).toEqual({ type: "renewed", version: 1, expiresAt: 4 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(broker.snapshot()).toMatchObject({
      onlineGateways: 1,
      activeStreams: 1,
      pendingStreams: 1,
    });
    expect(firstStream.destroyed).toBe(false);
    expect(broker.canClaim("account", secondTicket)).toBe(true);
    sendRenewal(control, "fictional-session-two");
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(control.sent.at(-1)!)).toEqual({ type: "renewed", version: 1, expiresAt: 6 });
    await vi.advanceTimersByTimeAsync(1001);
    expect(firstStream.destroyed).toBe(false);
    broker.claim("account", secondTicket, new Control().socket);
    const secondStream = await secondPending;
    expect(broker.snapshot()).toMatchObject({
      onlineGateways: 1,
      activeStreams: 2,
      pendingStreams: 0,
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(firstStream.destroyed).toBe(true);
    expect(secondStream.destroyed).toBe(true);
    expect(control.terminate).toHaveBeenCalledOnce();
    expect(broker.online("account")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    broker.close();
  }
});

test("a legacy peer cannot request renewal and still expires on its original deadline", async () => {
  const broker = new TunnelBroker();
  const legacy = new Control();
  broker.attach("legacy", legacy.socket, 2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(broker.online("legacy")).toBe(false);
  const unnegotiated = new Control();
  broker.attach("other", unnegotiated.socket, 4);
  sendRenewal(unnegotiated);
  expect(unnegotiated.close).toHaveBeenCalledWith(1008, "Unexpected control message");
  broker.close();
});

test.each([NaN, Infinity, 4.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 2, 1, 0, -1])(
  "an invalid or nonextending verified expiry %s cannot extend a routing session",
  async (next) => {
    const broker = new TunnelBroker();
    const control = new Control();
    broker.attach("account", control.socket, 2, false, async () => next);
    sendRenewal(control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.terminate).toHaveBeenCalledOnce();
    expect(broker.online("account")).toBe(false);
    expect(control.sent.map((frame) => JSON.parse(frame).type)).toEqual(["ready"]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("a replayed session cannot renew a second time", async () => {
  const broker = new TunnelBroker();
  const control = new Control();
  broker.attach("account", control.socket, 2, false, async () => 4);
  sendRenewal(control);
  await vi.advanceTimersByTimeAsync(0);
  sendRenewal(control);
  await vi.advanceTimersByTimeAsync(0);
  expect(control.sent.map((frame) => JSON.parse(frame).type)).toEqual(["ready", "renewed"]);
  expect(control.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["foreign account", "invalid signature"])(
  "a renewal refused by verification (%s) closes its own streams and pending channels",
  async (reason) => {
    const broker = new TunnelBroker();
    const control = new Control();
    const other = new Control();
    const verify = vi.fn(async () => {
      throw new Error(reason);
    });
    broker.attach("account", control.socket, 2, true, verify);
    broker.attach("other", other.socket, 20);
    const opening = broker.open("account", new AbortController().signal);
    broker.claim(
      "account",
      JSON.parse(control.sent.at(-1)!).ticket as string,
      new Control().socket,
    );
    const stream = await opening;
    const pending = broker.open("account", new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("Gateway disconnected");
    sendRenewal(control);
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(stream.destroyed).toBe(true);
    expect(broker.online("account")).toBe(false);
    expect(broker.online("other")).toBe(true);
    expect(control.sent.some((frame) => JSON.parse(frame).type === "renewed")).toBe(false);
    broker.close();
  },
);

test.each([
  "not-json",
  JSON.stringify({ type: "renew", version: 1, session: "" }),
  JSON.stringify({ type: "renew", version: 1, session: "x".repeat(4097) }),
  JSON.stringify({ type: "renew", version: 2, session: "fictional" }),
  JSON.stringify({ type: "renew", version: 1, session: "fictional", expiresAt: 50 }),
])("malformed negotiated renewal cannot extend the deadline or reach verification: %s", (input) => {
  const broker = new TunnelBroker();
  const control = new Control();
  const verify = vi.fn(async () => 4);
  broker.attach("account", control.socket, 2, false, verify);
  control.emit("message", Buffer.from(input));
  expect(verify).not.toHaveBeenCalled();
  expect(control.terminate).toHaveBeenCalledOnce();
  expect(broker.online("account")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("only one renewal verification can run on a socket and a concurrent duplicate cannot resurrect it", async () => {
  const broker = new TunnelBroker();
  const control = new Control();
  let finish!: (expiry: number) => void;
  const verify = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  broker.attach("account", control.socket, 2, false, verify);
  sendRenewal(control);
  sendRenewal(control);
  expect(verify).toHaveBeenCalledOnce();
  expect(control.terminate).toHaveBeenCalledOnce();
  finish(10);
  await vi.advanceTimersByTimeAsync(0);
  expect(control.sent.map((frame) => JSON.parse(frame).type)).toEqual(["ready"]);
  expect(broker.online("account")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["expiry", "account-close", "shutdown", "socket-close", "replacement", "closing-socket"])(
  "a late successful verification cannot undo %s",
  async (ending) => {
    const broker = new TunnelBroker();
    const control = new Control();
    let finish!: (expiry: number) => void;
    broker.attach(
      "account",
      control.socket,
      2,
      false,
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    sendRenewal(control);
    let replacement: Control | undefined;
    if (ending === "expiry") await vi.advanceTimersByTimeAsync(2000);
    else if (ending === "account-close") broker.closeAccount("account");
    else if (ending === "shutdown") broker.close();
    else if (ending === "closing-socket") control.readyState = WebSocket.CLOSING;
    else {
      control.terminate();
      if (ending === "replacement") {
        replacement = new Control();
        broker.attach("account", replacement.socket, 10);
      }
    }
    finish(20);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.sent.map((frame) => JSON.parse(frame).type)).toEqual(["ready"]);
    expect(broker.online("account")).toBe(Boolean(replacement));
    if (replacement) expect(replacement.terminate).not.toHaveBeenCalled();
    broker.close();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("verification completing after the authoritative deadline cannot win a delayed timer race", async () => {
  const broker = new TunnelBroker();
  const control = new Control();
  let finish!: (expiry: number) => void;
  broker.attach(
    "account",
    control.socket,
    2,
    false,
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  sendRenewal(control);
  // Move wall time without running timers: authentication must recheck time itself.
  vi.setSystemTime(2000);
  finish(10);
  await vi.advanceTimersByTimeAsync(0);
  expect(control.terminate).toHaveBeenCalledOnce();
  expect(control.sent.map((frame) => JSON.parse(frame).type)).toEqual(["ready"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("distant renewed deadlines use bounded timer slices rather than overflowing Node timers", async () => {
  const broker = new TunnelBroker({ ...DEFAULT_TUNNEL_LIMITS, heartbeatMs: 715_827_882 });
  const control = new Control();
  control.ping.mockImplementation(() => control.emit("pong"));
  broker.attach("account", control.socket, 2, false, async () => 3_000_000);
  sendRenewal(control);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(broker.online("account")).toBe(true);
  await vi.advanceTimersByTimeAsync(3_000_000_000 - 2_147_483_647);
  expect(broker.online("account")).toBe(false);
  expect(control.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["expired", "closing"])(
  "a renewal received on an already %s session never starts verification",
  (state) => {
    const broker = new TunnelBroker();
    const control = new Control();
    const verify = vi.fn(async () => 4);
    broker.attach("account", control.socket, 2, false, verify);
    if (state === "expired") vi.setSystemTime(2000);
    else control.readyState = WebSocket.CLOSING;
    sendRenewal(control);
    expect(verify).not.toHaveBeenCalled();
    expect(control.terminate).toHaveBeenCalledOnce();
    expect(broker.online("account")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("a verification failure after revocation cannot affect the replacement tunnel", async () => {
  const broker = new TunnelBroker();
  const control = new Control();
  let fail!: (error: Error) => void;
  broker.attach(
    "account",
    control.socket,
    2,
    false,
    () =>
      new Promise<number>((_resolve, reject) => {
        fail = reject;
      }),
  );
  sendRenewal(control);
  broker.closeAccount("account");
  const replacement = new Control();
  broker.attach("account", replacement.socket, 4);
  fail(new Error("expired verification"));
  await vi.advanceTimersByTimeAsync(0);
  expect(broker.online("account")).toBe(true);
  expect(replacement.terminate).not.toHaveBeenCalled();
  expect(control.terminate).toHaveBeenCalledOnce();
  broker.close();
});

test("channel rejection still works independently while renewal verification is in flight", async () => {
  const broker = new TunnelBroker();
  const control = new Control();
  let finish!: (expiry: number) => void;
  broker.attach(
    "account",
    control.socket,
    2,
    true,
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = broker.open("account", new AbortController().signal);
  const ticket = JSON.parse(control.sent.at(-1)!).ticket as string;
  const rejected = expect(pending).rejects.toThrow("Gateway channel capacity reached");
  sendRenewal(control);
  control.emit("message", Buffer.from(JSON.stringify({ type: "reject", version: 1, ticket })));
  await rejected;
  expect(broker.online("account")).toBe(true);
  finish(4);
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(control.sent.at(-1)!)).toEqual({ type: "renewed", version: 1, expiresAt: 4 });
  broker.close();
});

test("a queued renewal on a replaced control cannot revoke its successor or attribute a refusal to it", async () => {
  const metrics = new CloudRelayMetrics();
  const events = vi.spyOn(metrics, "tunnel");
  const broker = new TunnelBroker(DEFAULT_TUNNEL_LIMITS, metrics);
  const previous = new Control();
  const verify = vi.fn(async () => 10);
  broker.attach("account", previous.socket, 2, false, verify);
  previous.terminate();
  const successor = new Control();
  broker.attach("account", successor.socket, 5, false, async () => 10);
  const pending = broker.open("account", new AbortController().signal).catch(() => undefined);
  const ticket = JSON.parse(successor.sent.at(-1)!).ticket as string;
  // A frame already queued on the old socket must remain owned by that socket.
  sendRenewal(previous);
  await vi.advanceTimersByTimeAsync(0);
  expect(verify).not.toHaveBeenCalled();
  expect(broker.online("account")).toBe(true);
  expect(broker.canClaim("account", ticket)).toBe(true);
  expect(successor.terminate).not.toHaveBeenCalled();
  expect(events).not.toHaveBeenCalledWith("session_renewal_refused");
  expect(broker.snapshot().pendingStreams).toBe(1);
  broker.close();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});
