// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GatewayTunnel, type GatewayTunnelOptions } from "./tunnel-client.js";
import { isRelayTunnelPeer, relayedClientAddress } from "./relay-client-address.js";
import type { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({ sockets: [] as unknown[], connect: vi.fn(), stream: vi.fn() }));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    constructor(
      readonly url: string,
      readonly options: unknown,
    ) {
      super();
      mocks.sockets.push(this);
    }
    terminate(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close");
    }
    close(): void {
      this.terminate();
    }
    open(): void {
      this.readyState = 1;
      this.emit("open");
    }
  }
  return { WebSocket: Socket, createWebSocketStream: mocks.stream };
});
vi.mock("./network.js", async (original) => ({
  ...(await original<typeof import("./network.js")>()),
  connectOrigin: mocks.connect,
}));

interface Socket extends EventEmitter {
  url: string;
  options: { headers: Record<string, string> };
  readyState: number;
  open(): void;
  terminate(): void;
}
const sockets = (): Socket[] => mocks.sockets as Socket[];
const options = (): GatewayTunnelOptions => ({
  relayUrl: "http://127.0.0.1:8787",
  gatewayUrl: "https://localhost:8765",
  gatewayId: randomUUID(),
  session: async () => "relay-test-session",
  reconnectMs: 10,
});
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  mocks.sockets.length = 0;
  mocks.connect.mockReset();
  mocks.stream.mockReset();
  mocks.connect.mockImplementation(async () => new PassThrough());
  mocks.stream.mockImplementation(() => new PassThrough());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("rejects disabled, remote-destination, invalid-ID and invalid-limit configurations", () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
  expect(() => new GatewayTunnel(options())).toThrow("OMNESIS_CLOUD_RELAY_ENABLED=1");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  expect(
    () => new GatewayTunnel({ ...options(), gatewayUrl: "https://gateway.example.test" }),
  ).toThrow("local gateway");
  expect(() => new GatewayTunnel({ ...options(), gatewayUrl: "http://localhost:8765" })).toThrow(
    "terminate TLS",
  );
  expect(() => new GatewayTunnel({ ...options(), gatewayId: "bad" })).toThrow();
  for (const maxChannels of [0, -1, 1.5, NaN])
    expect(() => new GatewayTunnel({ ...options(), maxChannels })).toThrow("positive");
  for (const reconnectMs of [0, -1, 1.5, NaN])
    expect(() => new GatewayTunnel({ ...options(), reconnectMs })).toThrow("positive");
});

test("start is idempotent, validates control frames, preserves session headers and reconnects", async () => {
  const tunnel = new GatewayTunnel(options());
  tunnel.start();
  tunnel.start();
  await flush();
  expect(sockets()).toHaveLength(1);
  tunnel.start();
  expect(sockets()).toHaveLength(1);
  const control = sockets()[0];
  expect(control.options.headers["x-omnesis-relay-session"]).toBe("relay-test-session");
  control.open();
  control.emit("message", Buffer.from('{"type":"ready","version":1,"heartbeatMs":30000}'));
  control.emit("ping");
  control.emit("message", Buffer.from("bad-json"));
  expect(control.readyState).toBe(3);
  await vi.advanceTimersByTimeAsync(10);
  expect(sockets()).toHaveLength(2);
  sockets()[1].emit("error", new Error("network down"));
  await vi.advanceTimersByTimeAsync(10);
  expect(sockets()).toHaveLength(3);
  tunnel.stop();
  tunnel.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets()).toHaveLength(3);
});

test("synchronous/asynchronous session failures retry and stopping cancels an in-flight credential read", async () => {
  const session = vi
    .fn<GatewayTunnelOptions["session"]>()
    .mockImplementationOnce(() => {
      throw new Error("file missing");
    })
    .mockRejectedValueOnce(new Error("file malformed"))
    .mockResolvedValue("renewed");
  const tunnel = new GatewayTunnel({ ...options(), session });
  tunnel.start();
  await flush();
  await vi.advanceTimersByTimeAsync(20);
  expect(session).toHaveBeenCalledTimes(3);
  expect(sockets()[0].options.headers["x-omnesis-relay-session"]).toBe("renewed");
  tunnel.stop();
  let resolve!: (token: string) => void;
  const pending = new GatewayTunnel({
    ...options(),
    session: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  pending.start();
  await flush();
  pending.stop();
  resolve("late");
  await flush();
  expect(sockets()).toHaveLength(1);
});

test("watchdog reconnects a half-open connection without needing the remote server", async () => {
  const tunnel = new GatewayTunnel(options());
  tunnel.start();
  await flush();
  sockets()[0].open();
  await vi.advanceTimersByTimeAsync(89_000);
  sockets()[0].emit("ping");
  await vi.advanceTimersByTimeAsync(89_000);
  expect(sockets()[0].readyState).toBe(1);
  await vi.advanceTimersByTimeAsync(1010);
  expect(sockets()[0].readyState).toBe(3);
  expect(sockets()).toHaveLength(2);
  tunnel.stop();
});

test("data channels are bounded and cancelled with their owner control session", async () => {
  const tunnel = new GatewayTunnel({ ...options(), maxChannels: 1 });
  tunnel.start();
  await flush();
  const control = sockets()[0];
  control.open();
  const message = Buffer.from(JSON.stringify({ type: "open", version: 1, ticket: "a".repeat(64) }));
  control.emit("message", message);
  expect(sockets()).toHaveLength(2);
  expect(sockets()[1].options.headers["x-omnesis-relay-ticket"]).toBe("a".repeat(64));
  sockets()[1].open();
  await flush();
  const destination = (await mocks.connect.mock.results[0].value) as PassThrough;
  control.emit("message", message);
  expect(control.readyState).toBe(3);
  expect(destination.destroyed).toBe(true);
  tunnel.stop();
});

test("destination failures and stream errors are contained, with no leaked pending connections", async () => {
  const tunnel = new GatewayTunnel(options());
  tunnel.start();
  await flush();
  const control = sockets()[0];
  control.open();
  const message = Buffer.from(JSON.stringify({ type: "open", version: 1, ticket: "b".repeat(64) }));
  mocks.connect.mockRejectedValueOnce(new Error("TLS validation failed"));
  control.emit("message", message);
  sockets()[1].open();
  await flush();
  expect((mocks.stream.mock.results[0].value as PassThrough).destroyed).toBe(true);
  sockets()[1].emit("error", new Error("socket reset"));
  let complete!: (destination: PassThrough) => void;
  mocks.connect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  control.emit("message", message);
  const data = sockets().at(-1)!;
  data.open();
  await flush();
  data.terminate();
  expect(mocks.connect.mock.calls.at(-1)![2].aborted).toBe(true);
  const stale = new PassThrough();
  complete(stale);
  await flush();
  expect(stale.destroyed).toBe(true);
  control.emit("message", message);
  sockets().at(-1)!.open();
  await flush();
  const stream = mocks.stream.mock.results.at(-1)!.value as PassThrough;
  stream.emit("error", new Error("stream failed"));
  await flush();
  expect(stream.destroyed).toBe(true);
  tunnel.stop();
});

test("negotiated heartbeat intervals extend the watchdog for healthy long-interval relays", async () => {
  const tunnel = new GatewayTunnel(options());
  tunnel.start();
  await flush();
  const control = sockets()[0];
  control.open();
  control.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "ready", version: 1, heartbeatMs: 120000 })),
  );
  await vi.advanceTimersByTimeAsync(120000);
  expect(control.readyState).toBe(1);
  control.emit("ping");
  await vi.advanceTimersByTimeAsync(359999);
  expect(control.readyState).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(control.readyState).toBe(3);
  tunnel.stop();
});

test("only a current handshake401 invalidates routing authority; other statuses and late stopped callbacks merely clean sockets", async () => {
  const invalidate = vi.fn();
  const tunnel = new GatewayTunnel({ ...options(), invalidateSession: invalidate });
  tunnel.start();
  await flush();
  const request = { destroy: vi.fn() },
    response = { statusCode: 503, destroy: vi.fn() };
  sockets()[0].emit("unexpected-response", request, response);
  expect(request.destroy).toHaveBeenCalledOnce();
  expect(response.destroy).toHaveBeenCalledOnce();
  expect(invalidate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10);
  const current = sockets()[1];
  current.emit("unexpected-response", request, { ...response, statusCode: 401 });
  expect(invalidate).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10);
  const late = sockets()[2];
  tunnel.stop();
  late.emit("unexpected-response", request, { ...response, statusCode: 401 });
  expect(invalidate).toHaveBeenCalledOnce();
});

test("multiple data401s invalidate once per control generation; invalidator failures cannot retain refused sockets", async () => {
  const invalidate = vi.fn();
  const tunnel = new GatewayTunnel({ ...options(), invalidateSession: invalidate });
  tunnel.start();
  await flush();
  const control = sockets()[0];
  control.open();
  control.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "open", version: 1, ticket: "a".repeat(64) })),
  );
  control.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "open", version: 1, ticket: "b".repeat(64) })),
  );
  const request = { destroy: vi.fn() },
    response = { statusCode: 401, destroy: vi.fn() };
  sockets()[1].emit("unexpected-response", request, response);
  sockets()[2].emit("unexpected-response", request, response);
  expect(invalidate).toHaveBeenCalledOnce();
  expect(sockets()[1].readyState).toBe(3);
  expect(sockets()[2].readyState).toBe(3);
  control.emit("message", Buffer.from("ignored stale message"));
  await vi.advanceTimersByTimeAsync(10);
  control.emit("close");
  tunnel.stop();
  const failing = new GatewayTunnel({
    ...options(),
    invalidateSession: () => {
      throw new Error("invalidator failed");
    },
  });
  failing.start();
  await flush();
  const refused = sockets().at(-1)!;
  refused.emit("unexpected-response", request, response);
  expect(refused.readyState).toBe(3);
  failing.stop();
  const legacy = new GatewayTunnel(options());
  legacy.start();
  await flush();
  sockets().at(-1)!.emit("unexpected-response", request, response);
  legacy.stop();
});

test("a session callback that never settles is aborted after a bounded deadline and retried; late failure cannot restart a stopped generation", async () => {
  let cancelled: AbortSignal | undefined;
  let finish!: (value: string) => void;
  const session = vi.fn(async (signal?: AbortSignal) => {
    cancelled = signal;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const tunnel = new GatewayTunnel({ ...options(), session });
  tunnel.start();
  await flush();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(cancelled!.aborted).toBe(true);
  session.mockResolvedValueOnce("fresh-after-timeout");
  await vi.advanceTimersByTimeAsync(10);
  expect(sockets()).toHaveLength(1);
  expect(sockets()[0].options.headers["x-omnesis-relay-session"]).toBe("fresh-after-timeout");
  finish("late-old-session");
  await flush();
  expect(sockets()).toHaveLength(1);
  tunnel.stop();
  let reject!: (error: Error) => void;
  const stopped = new GatewayTunnel({
    ...options(),
    session: () =>
      new Promise<string>((_resolve, fail) => {
        reject = fail;
      }),
  });
  stopped.start();
  await flush();
  stopped.stop();
  reject(new Error("late session failure"));
  await flush();
  expect(stopped.status().state).toBe("disabled");
  expect(vi.getTimerCount()).toBe(0);
});

test("a stop between acquired credentials and socket handoff rejects the completed generation and duplicate reconnect scheduling is harmless", async () => {
  const tunnel = new GatewayTunnel(options());
  const internals = tunnel as unknown as {
    acquireSession: () => Promise<string>;
    scheduleReconnect: () => void;
  };
  // Simulate the promise handoff boundary after credential I/O has already completed.
  vi.spyOn(internals, "acquireSession").mockImplementation(async () => {
    queueMicrotask(() => tunnel.stop());
    return "completed-session";
  });
  tunnel.start();
  await flush();
  expect(sockets()).toHaveLength(0);
  internals.scheduleReconnect();
  const retry = new GatewayTunnel(options());
  const scheduling = retry as unknown as { scheduleReconnect: () => void };
  scheduling.scheduleReconnect();
  scheduling.scheduleReconnect();
  expect(vi.getTimerCount()).toBe(1);
  retry.stop();
});

test("the relay's address for a stream is recorded against the dialled gateway socket, and a malformed one is ignored", async () => {
  const tunnel = new GatewayTunnel(options());
  tunnel.start();
  await flush();
  const control = sockets()[0];
  control.open();
  const dial = (client: unknown, localPort: number) => {
    const destination = Object.assign(new PassThrough(), { localAddress: "127.0.0.1", localPort });
    mocks.connect.mockResolvedValueOnce(destination);
    control.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "open", version: 1, ticket: "c".repeat(64), client })),
    );
    sockets().at(-1)!.open();
    return destination;
  };
  const named = dial("203.0.113.20", 41001);
  dial("not-an-address", 41002);
  dial(undefined, 41003);
  await flush();
  const at = (remotePort: number) =>
    relayedClientAddress({ remoteAddress: "127.0.0.1", remotePort });
  expect(at(41001)).toBe("203.0.113.20");
  expect(at(41002)).toBeUndefined();
  expect(at(41003)).toBeUndefined();
  // Whatever the relay named, or left out, every dialled socket is known to be the relay's.
  for (const port of [41001, 41002, 41003])
    expect(isRelayTunnelPeer({ remoteAddress: "127.0.0.1", remotePort: port })).toBe(true);
  named.destroy();
  await flush();
  expect(at(41001)).toBeUndefined();
  expect(isRelayTunnelPeer({ remoteAddress: "127.0.0.1", remotePort: 41001 })).toBe(false);
  // An overlong value is not a valid control frame at all.
  control.emit(
    "message",
    Buffer.from(
      JSON.stringify({ type: "open", version: 1, ticket: "d".repeat(64), client: "1".repeat(65) }),
    ),
  );
  expect(control.readyState).toBe(3);
  tunnel.stop();
});

test("a relay behind a proxy moves the tunnel and its channels to the address it names", async () => {
  const tunnel = new GatewayTunnel({ ...options(), relayUrl: "https://relay.example.test" });
  const request = { destroy: vi.fn() };
  const moved = (location: string | undefined, statusCode = 307) => ({
    statusCode,
    headers: { location },
    destroy: vi.fn(),
  });
  tunnel.start();
  await flush();
  // Offers to move; a refusal that names no usable address changes nothing.
  for (const [index, response] of [
    moved(undefined),
    moved("not a url"),
    moved("wss://tunnel.example.test/_relay/v1/data"),
    moved("wss://tunnel.example.test/_relay/v1/tunnel?x=1"),
    moved("wss://tunnel.example.test/_relay/v1/tunnel#x"),
    moved("ws://tunnel.example.test/_relay/v1/tunnel"),
    moved("wss://tunnel.example.test/_relay/v1/tunnel", 302),
  ].entries()) {
    const control = sockets()[index];
    expect(control.url).toBe("wss://relay.example.test/_relay/v1/tunnel");
    expect(control.options.headers["x-omnesis-tunnel-direct"]).toBe("1");
    control.emit("unexpected-response", request, response);
    await vi.advanceTimersByTimeAsync(10);
  }
  // One that does is followed, without offering again.
  sockets()[7].emit(
    "unexpected-response",
    request,
    moved("wss://tunnel.example.test/_relay/v1/tunnel"),
  );
  await vi.advanceTimersByTimeAsync(10);
  const direct = sockets()[8];
  expect(direct.url).toBe("wss://tunnel.example.test/_relay/v1/tunnel");
  expect(direct.options.headers).not.toHaveProperty("x-omnesis-tunnel-direct");
  expect(direct.options.headers["x-omnesis-relay-session"]).toBe("relay-test-session");
  direct.open();
  direct.emit("message", Buffer.from('{"type":"ready","version":1,"heartbeatMs":30000}'));
  direct.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "open", version: 1, ticket: "a".repeat(64) })),
  );
  expect(sockets()[9].url).toBe("wss://tunnel.example.test/_relay/v1/data");
  // A tunnel that worked there comes back there, and a redirect from there is not followed.
  direct.terminate();
  await vi.advanceTimersByTimeAsync(10);
  const again = sockets()[10];
  expect(again.url).toBe("wss://tunnel.example.test/_relay/v1/tunnel");
  again.emit(
    "unexpected-response",
    request,
    moved("wss://elsewhere.example.test/_relay/v1/tunnel"),
  );
  // It never got ready there: the relay's own address is used, without offering, for a while.
  await vi.advanceTimersByTimeAsync(10);
  const fallback = sockets()[11];
  expect(fallback.url).toBe("wss://relay.example.test/_relay/v1/tunnel");
  expect(fallback.options.headers).not.toHaveProperty("x-omnesis-tunnel-direct");
  fallback.open();
  fallback.emit("message", Buffer.from('{"type":"ready","version":1,"heartbeatMs":30000}'));
  expect(tunnel.status().state).toBe("online");
  vi.setSystemTime(Date.now() + 5 * 60_000);
  fallback.terminate();
  await vi.advanceTimersByTimeAsync(10);
  expect(sockets()[12].options.headers["x-omnesis-tunnel-direct"]).toBe("1");
  tunnel.stop();
});
