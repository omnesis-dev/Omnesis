// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PassThrough } from "node:stream";
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ServerResponse, type IncomingMessage } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  challengeIsFresh,
  CLOCK_SKEW_MS,
  connectOrigin,
  forwardHttp,
  forwardedHeaders,
  forwardUpgrade,
  isLoopback,
  relayOrigin,
  SESSION_HEADER,
  websocketUrl,
} from "./network.js";

const mocks = vi.hoisted(() => ({ tcp: vi.fn(), tls: vi.fn() }));
vi.mock("node:net", async (original) => ({
  ...(await original<typeof import("node:net")>()),
  connect: mocks.tcp,
}));
vi.mock("node:tls", async (original) => ({
  ...(await original<typeof import("node:tls")>()),
  connect: mocks.tls,
}));

class Dial extends PassThrough {
  setTimeout = vi.fn((_ms: number, _listener?: () => void) => this);
  setKeepAlive = vi.fn((_enable: boolean, _delay: number) => this);
}
beforeEach(() => {
  mocks.tcp.mockReset();
  mocks.tls.mockReset();
});
afterEach(() => vi.restoreAllMocks());

test("relay origins reject credentials, paths, query, fragments and insecure remote transports", () => {
  for (const url of [
    "https://name@relay.example.test",
    "https://:password@relay.example.test",
    "https://relay.example.test/path",
    "https://relay.example.test/?query=one",
    "https://relay.example.test/#fragment",
  ])
    expect(() => relayOrigin(url)).toThrow("origin");
  for (const url of ["http://relay.example.test", "ws://localhost", "ftp://localhost"])
    expect(() => relayOrigin(url)).toThrow("HTTPS");
  for (const url of [
    "http://127.0.0.1",
    "http://localhost",
    "http://[::1]",
    "https://relay.example.test",
  ])
    expect(relayOrigin(url)).toBeInstanceOf(URL);
  expect(isLoopback("relay.example.test")).toBe(false);
  expect(websocketUrl(new URL("https://relay.example.test"), "/_relay/v1/tunnel")).toBe(
    "wss://relay.example.test/_relay/v1/tunnel",
  );
  expect(websocketUrl(new URL("http://localhost:1234"), "/device/ws")).toBe(
    "ws://localhost:1234/device/ws",
  );
});

test("fixed-origin dials choose the correct port, strip IPv6 brackets and verify TLS", async () => {
  for (const [url, port, tls] of [
    ["http://127.0.0.1", 80, false],
    ["https://localhost", 443, true],
    ["https://localhost:4443", 4443, true],
    ["http://[::1]:8080", 8080, false],
  ] as const) {
    const socket = new Dial();
    (tls ? mocks.tls : mocks.tcp).mockReturnValueOnce(socket);
    const promise = connectOrigin(new URL(url), tls ? "fictional-ca" : undefined);
    socket.emit(tls ? "secureConnect" : "connect");
    expect(await promise).toBe(socket);
    expect((tls ? mocks.tls : mocks.tcp).mock.calls.at(-1)![0]).toMatchObject({
      port,
      host: new URL(url).hostname.replace(/^\[|\]$/g, ""),
    });
    if (tls)
      expect(mocks.tls.mock.calls.at(-1)![0]).toMatchObject({
        rejectUnauthorized: true,
        ca: "fictional-ca",
      });
    expect(socket.setTimeout).toHaveBeenLastCalledWith(0);
    // A vanished peer is noticed while the connection is idle, and the handshake deadline
    // does not stay behind to fire on a later idle timer of the caller's.
    expect(socket.setKeepAlive).toHaveBeenCalledExactlyOnceWith(true, 15_000);
    expect(socket.listenerCount("timeout")).toBe(0);
    socket.destroy();
  }
});

test("connection errors, deadlines and aborts destroy the dial and release abort listeners", async () => {
  const error = new Dial();
  mocks.tcp.mockReturnValueOnce(error);
  const failed = connectOrigin(new URL("http://localhost:1"));
  error.emit("error", new Error("connection refused"));
  await expect(failed).rejects.toThrow("refused");
  expect(error.destroyed).toBe(true);
  const timeout = new Dial();
  mocks.tcp.mockReturnValueOnce(timeout);
  const expired = connectOrigin(new URL("http://localhost:1"));
  const expiredCheck = expect(expired).rejects.toThrow("timed out");
  timeout.setTimeout.mock.calls[0][1]!();
  await expiredCheck;
  for (const alreadyAborted of [false, true]) {
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const socket = new Dial();
    mocks.tcp.mockReturnValueOnce(socket);
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = connectOrigin(new URL("http://localhost:1"), undefined, controller.signal);
    const failure = expect(pending).rejects.toThrow("aborted");
    if (!alreadyAborted) controller.abort();
    await failure;
    await new Promise((resolve) => setImmediate(resolve));
    expect(remove).toHaveBeenCalled();
  }
});

test("forwarding removes relay and untrusted proxy metadata while retaining gateway authorization", () => {
  const headers = forwardedHeaders(
    {
      headers: {
        [SESSION_HEADER]: "untrusted",
        "x-omnesis-relay-ticket": "untrusted",
        "x-omnesis-gateway-id": "untrusted",
        "proxy-authorization": "untrusted",
        "proxy-connection": "untrusted",
        forwarded: "untrusted",
        "x-forwarded-host": "untrusted",
        "x-forwarded-proto": "untrusted",
        authorization: "Bearer gateway-token",
        cookie: "gateway-session=fictional",
      },
    },
    "gateway.local",
  );
  expect(headers).toEqual({
    host: "gateway.local",
    authorization: "Bearer gateway-token",
    cookie: "gateway-session=fictional",
    "x-omnesis-cloud-relay": "1",
  });
});

test("upgrade forwarding preserves repeated headers and bytes already read after the handshake", async () => {
  // Duplex endpoints with independent readable/writable halves avoid an echo
  // loop while asserting both the serialized handshake and the pending frame.
  const { Duplex } = await import("node:stream");
  const writes: Buffer[] = [];
  const upstream = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      writes.push(Buffer.from(chunk));
      done();
    },
  });
  const downstream = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  forwardUpgrade(
    {
      method: "GET",
      url: "/device/ws",
      headers: { "set-cookie": ["first", "second"] },
    },
    downstream,
    Buffer.from("pending-frame"),
    upstream,
    "gateway.local",
  );
  expect(Buffer.concat(writes).toString()).toContain("set-cookie: first\r\nset-cookie: second\r\n");
  expect(Buffer.concat(writes).toString()).toContain("\r\n\r\npending-frame");
  downstream.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  expect(upstream.destroyed).toBe(true);
});

test("an interrupted upload destroys its upstream without retaining the dial", async () => {
  const { Duplex } = await import("node:stream");
  const incoming = Object.assign(new PassThrough(), {
    method: "POST",
    url: "/documents/upsert",
    headers: { "content-length": "1000" },
  }) as unknown as IncomingMessage;
  const response = new ServerResponse(incoming);
  const upstream = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  forwardHttp(incoming, response, upstream, "gateway.local");
  incoming.destroy(new Error("client disconnected mid-upload"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(upstream.destroyed).toBe(true);
});

test("opaque gateway dials preserve TLS bytes and connection overrides retain the original SNI and pin", async () => {
  const raw = new Dial();
  mocks.tcp.mockReturnValueOnce(raw);
  const connection = connectOrigin(new URL("https://localhost:8443"), undefined, undefined, true);
  raw.emit("connect");
  expect(await connection).toBe(raw);
  expect(mocks.tcp).toHaveBeenLastCalledWith({ host: "localhost", port: 8443 });
  expect(mocks.tls).not.toHaveBeenCalled();
  raw.destroy();
  await expect(
    connectOrigin(
      new URL("https://gateway.example.test"),
      undefined,
      undefined,
      false,
      "a".repeat(64),
      "attacker.example.test",
    ),
  ).rejects.toThrow("IP address");
  const fixture = JSON.parse(
    readFileSync(new URL("../test/identity-vectors.json", import.meta.url), "utf8"),
  );
  const cert = new X509Certificate(fixture.gateway.certificate);
  const peer = { subjectaltname: cert.subjectAltName, raw: cert.raw };
  const host = new URL(fixture.gateway.publicOrigin).hostname;
  const fingerprint = createHash("sha256").update(cert.raw).digest("hex");
  for (const pin of [undefined, fingerprint, "f".repeat(64)]) {
    const tls = new Dial();
    mocks.tls.mockReturnValueOnce(tls);
    const dial = connectOrigin(
      new URL(`https://${host}`),
      "test-ca",
      undefined,
      false,
      pin,
      "127.0.0.1",
    );
    const options = mocks.tls.mock.calls.at(-1)![0];
    expect(options).toMatchObject({
      host: "127.0.0.1",
      servername: host,
      rejectUnauthorized: true,
    });
    expect(options.checkServerIdentity("another.example.test", peer)).toBeInstanceOf(Error);
    expect(options.checkServerIdentity(host, peer)?.message).toBe(
      pin === "f".repeat(64) ? "Gateway certificate pin mismatch" : undefined,
    );
    tls.emit("secureConnect");
    expect(await dial).toBe(tls);
    tls.destroy();
  }
  const ip = new Dial();
  mocks.tls.mockReturnValueOnce(ip);
  const dial = connectOrigin(new URL("https://127.0.0.1"));
  expect(mocks.tls.mock.calls.at(-1)![0].servername).toBeUndefined();
  ip.emit("secureConnect");
  await dial;
  ip.destroy();
});

test("connection port overrides are bounded and key pins require a real TLS handshake", async () => {
  for (const port of [0, 65536, 1.5])
    await expect(
      connectOrigin(
        new URL("https://gateway.example.test"),
        undefined,
        undefined,
        false,
        undefined,
        "127.0.0.1",
        port,
      ),
    ).rejects.toThrow("port");
  await expect(
    connectOrigin(
      new URL("https://gateway.example.test"),
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      "invalid",
    ),
  ).rejects.toThrow("public key pin");
  for (const [url, opaque] of [
    ["http://localhost", false],
    ["https://localhost", true],
  ] as const)
    await expect(
      connectOrigin(
        new URL(url),
        undefined,
        undefined,
        opaque,
        undefined,
        undefined,
        undefined,
        "a".repeat(64),
      ),
    ).rejects.toThrow("requires gateway TLS");
  const vectors = JSON.parse(
    readFileSync(new URL("../test/identity-vectors.json", import.meta.url), "utf8"),
  );
  const { tlsSpkiFingerprint } = await import("./pinned-key.js");
  const cert = new X509Certificate(vectors.gateway.certificate);
  vi.useFakeTimers({ toFake: ["Date"], now: vectors.clock * 1000 });
  try {
    for (const pin of [tlsSpkiFingerprint(cert.raw), "a".repeat(64)]) {
      const socket = new Dial();
      Object.assign(socket, {
        getPeerCertificate: () => ({ raw: cert.raw, subjectaltname: "DNS:gateway.example.test" }),
      });
      mocks.tls.mockReturnValueOnce(socket);
      const promise = connectOrigin(
        new URL("https://gateway.example.test"),
        undefined,
        undefined,
        false,
        undefined,
        "192.0.2.12",
        7600,
        pin,
      );
      socket.emit("secureConnect");
      if (pin === tlsSpkiFingerprint(cert.raw)) expect(await promise).toBe(socket);
      else await expect(promise).rejects.toThrow("key pin mismatch");
      expect(mocks.tls.mock.calls.at(-1)![0]).toMatchObject({
        servername: "gateway.example.test",
        host: "192.0.2.12",
        port: 7600,
        rejectUnauthorized: false,
      });
      socket.destroy();
    }
  } finally {
    vi.useRealTimers();
  }
});

test("TLS identity classification uses the actual authorization code and preserves unrelated network errors", async () => {
  const { GatewayTlsIdentityRefused } = await import("./pinned-key.js");
  const trustCode = "DEPTH_ZERO_SELF_SIGNED_CERT";
  for (const [url, opaque, authorization, error, identity] of [
    [
      "https://localhost",
      false,
      trustCode,
      Object.assign(new Error("certificate"), { code: trustCode }),
      true,
    ],
    [
      "https://localhost",
      false,
      trustCode,
      Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      false,
    ],
    ["https://localhost", false, trustCode, new Error("protocol"), false],
    ["https://localhost", false, trustCode, "protocol", false],
    [
      "https://localhost",
      false,
      undefined,
      Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      false,
    ],
    [
      "https://localhost",
      false,
      new Error("certificate"),
      Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      false,
    ],
    [
      "https://localhost",
      true,
      trustCode,
      Object.assign(new Error("certificate"), { code: trustCode }),
      false,
    ],
    [
      "http://localhost",
      false,
      trustCode,
      Object.assign(new Error("certificate"), { code: trustCode }),
      false,
    ],
  ] as const) {
    const socket = Object.assign(new Dial(), { authorizationError: authorization });
    (url.startsWith("https:") && !opaque ? mocks.tls : mocks.tcp).mockReturnValueOnce(socket);
    const result = connectOrigin(new URL(url), undefined, undefined, opaque);
    socket.emit("error", error);
    if (identity) await expect(result).rejects.toBeInstanceOf(GatewayTlsIdentityRefused);
    else await expect(result).rejects.toBe(error);
  }
  const controller = new AbortController();
  const socket = Object.assign(new Dial(), { authorizationError: "ABORT_ERR" });
  mocks.tls.mockReturnValueOnce(socket);
  const aborted = connectOrigin(new URL("https://localhost"), undefined, controller.signal);
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ code: "ABORT_ERR" });
});

test("a challenge from a relay whose clock is a little off is still fresh", () => {
  const now = 1_800_000_000_000;
  // The relay stamped it a minute ahead of its own clock, which runs 130 ms ahead of ours.
  expect(challengeIsFresh(now + 60_130, now)).toBe(true);
  expect(challengeIsFresh(now - 30_000, now)).toBe(true);
  expect(challengeIsFresh(now + 60_000 + CLOCK_SKEW_MS, now)).toBe(true);
  expect(challengeIsFresh(now + 60_001 + CLOCK_SKEW_MS, now)).toBe(false);
  expect(challengeIsFresh(now - CLOCK_SKEW_MS, now)).toBe(false);
  expect(challengeIsFresh(Date.now() + 60_000)).toBe(true);
});
