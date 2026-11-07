// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer as httpsServer } from "node:https";
import { request, Agent } from "node:http";
import { once } from "node:events";
import { expect, test, vi, afterEach } from "vitest";
import { fixture, echoGateway, tlsFiles, listen, closeServer } from "../test/support.js";
import { createRelayClientProxy } from "./client-proxy.js";
import { connectOrigin } from "./network.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import { certificateFingerprint } from "./gateway-binding.js";
import type { Duplex } from "node:stream";

afterEach(() => vi.unstubAllEnvs());
// The synthetic private address maps to the loopback fixture; actual TLS, pins, SNI and ports are unchanged.
const localDial: typeof connectOrigin = (origin, ca, signal, opaque, pin, _host, port, spki) =>
  connectOrigin(origin, ca, signal, opaque, pin, "127.0.0.1", port, spki);

test("same-LAN adapter sends HTTP and WebSocket directly; unreachable LAN falls back once to opaque relay", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const f = await fixture(),
    gateway = await echoGateway();
  let relayConnections = 0;
  f.relay.dataServer.on("connection", () => relayConnections++);
  const adapters: ReturnType<typeof createRelayClientProxy>[] = [];
  try {
    await f.tunnel(gateway.url);
    const baseline = relayConnections;
    const directPort = Number(new URL(gateway.url).port);
    const options = {
      gatewayUrl: f.gatewayUrl,
      gatewayCa: gateway.certificate,
      gatewayFingerprint: gateway.fingerprint,
      expectedGatewayToken: "fixture-token",
      directCandidates: [{ address: "192.168.1.20", port: directPort }],
    };
    const direct = createRelayClientProxy(options, { connect: localDial });
    adapters.push(direct);
    const url = await listen(direct.server);
    const body = "synthetic-private-collector-body";
    const response = await fetch(url + "/binary", {
      method: "POST",
      headers: { authorization: "Bearer fixture-token" },
      body,
    });
    expect(await response.text()).toBe(body);
    expect(relayConnections).toBe(baseline);
    const seen = gateway.requests.at(-1)!;
    expect(seen.headers.host).toBe(new URL(f.gatewayUrl).host);
    expect(seen.body.toString()).toBe(body);
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(url.replace("http:", "ws:") + "/device/ws", {
      headers: { authorization: "Bearer fixture-token" },
    });
    await once(ws, "open");
    ws.send("synthetic-private-websocket");
    expect(String((await once(ws, "message"))[0])).toBe("synthetic-private-websocket");
    ws.terminate();
    expect(relayConnections).toBe(baseline);
    // A known closed port gives a real TCP refusal before any request body is written.
    const closed = httpsServer();
    const closedUrl = await listen(closed);
    const closedPort = Number(new URL(closedUrl).port);
    await closeServer(closed);
    const fallback = createRelayClientProxy(
      { ...options, directCandidates: [{ address: "192.168.1.20", port: closedPort }] },
      { connect: localDial },
    );
    adapters.push(fallback);
    const fallbackUrl = await listen(fallback.server);
    expect(
      await (
        await fetch(fallbackUrl + "/binary", {
          method: "POST",
          headers: { authorization: "Bearer fixture-token" },
          body: "fallback-body",
        })
      ).text(),
    ).toBe("fallback-body");
    expect(relayConnections).toBe(baseline + 1);
    expect(gateway.requests.filter((row) => row.body.toString() === "fallback-body")).toHaveLength(
      1,
    );
    const refused = createRelayClientProxy(
      { ...options, gatewayFingerprint: "a".repeat(64) },
      { connect: localDial },
    );
    adapters.push(refused);
    const refusedUrl = await listen(refused.server);
    const requestCount = gateway.requests.length;
    expect(
      (
        await fetch(refusedUrl + "/api/private", {
          headers: { authorization: "Bearer fixture-token" },
        })
      ).status,
    ).toBe(502);
    expect(gateway.requests.length).toBe(requestCount);
    expect(relayConnections).toBe(baseline + 1);
    const rejectedWs = new WebSocket(refusedUrl.replace("http:", "ws:") + "/device/ws", {
      headers: { authorization: "Bearer fixture-token" },
    });
    await once(rejectedWs, "error");
    rejectedWs.terminate();
    expect(gateway.requests.length).toBe(requestCount);
    expect(relayConnections).toBe(baseline + 1);
    const revoked = createRelayClientProxy(
      { ...options, expectedGatewayToken: "revoked-token" },
      { connect: localDial },
    );
    adapters.push(revoked);
    expect(
      (
        await fetch((await listen(revoked.server)) + "/api/private", {
          headers: { authorization: "Bearer revoked-token" },
        })
      ).status,
    ).toBe(401);
    expect(relayConnections).toBe(baseline + 1);
    const before = relayConnections;
    expect(
      (
        await fetch(url + "/api/private", {
          headers: { authorization: "Bearer wrong-device-token" },
        })
      ).status,
    ).toBe(403);
    expect(relayConnections).toBe(before);
  } finally {
    for (const adapter of adapters) await adapter.close();
    await f.close();
    await gateway.close();
  }
});

async function exchange(stream: Duplex, host: string): Promise<string> {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => stream;
  try {
    const req = request({
      agent,
      path: "/private",
      headers: { host, authorization: "Bearer private-test-token" },
    });
    const response = once(req, "response");
    req.end();
    const [reply] = await response;
    const chunks: Buffer[] = [];
    for await (const c of reply) chunks.push(c);
    return Buffer.concat(chunks).toString();
  } finally {
    agent.destroy();
    stream.destroy();
  }
}

test("stable leaf-key pin survives same-key certificate renewal while exact legacy pin and replacement/hostname/expiry fail before credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-renewal-tls-"));
  const files = tlsFiles(directory, "gateway.example.test");
  const original = await readFile(files.certFile, "utf8"),
    key = await readFile(files.keyFile, "utf8");
  let requests = 0;
  const server = httpsServer({ cert: original, key }, (req, res) => {
    requests++;
    expect(req.headers.authorization).toBe("Bearer private-test-token");
    res.end("private-reply");
  });
  const address = await listen(server);
  const origin = new URL(address.replace("http://127.0.0.1", "https://gateway.example.test"));
  const pin = tlsSpkiFingerprint(original),
    exact = certificateFingerprint(original);
  try {
    const renew = (hostname: string, serial: string) => {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-key",
          files.keyFile,
          "-out",
          files.certFile,
          "-days",
          "1",
          "-set_serial",
          serial,
          "-subj",
          "/CN=synthetic",
          "-addext",
          `subjectAltName=DNS:${hostname}`,
        ],
        { stdio: "ignore" },
      );
    };
    renew("gateway.example.test", "2");
    const renewed = await readFile(files.certFile, "utf8");
    expect(certificateFingerprint(renewed)).not.toBe(exact);
    expect(tlsSpkiFingerprint(renewed)).toBe(pin);
    server.setSecureContext({ cert: renewed, key });
    await expect(
      connectOrigin(origin, original, undefined, false, exact, "127.0.0.1"),
    ).rejects.toThrow();
    expect(requests).toBe(0);
    const secure = await connectOrigin(
      origin,
      original,
      undefined,
      false,
      exact,
      "127.0.0.1",
      undefined,
      pin,
    );
    expect(await exchange(secure, origin.host)).toBe("private-reply");
    expect(requests).toBe(1);
    await expect(
      connectOrigin(
        origin,
        original,
        undefined,
        false,
        exact,
        "127.0.0.1",
        undefined,
        "a".repeat(64),
      ),
    ).rejects.toThrow("key pin mismatch");
    expect(requests).toBe(1);
    renew("wrong.example.test", "3");
    server.setSecureContext({ cert: await readFile(files.certFile, "utf8"), key });
    await expect(
      connectOrigin(origin, original, undefined, false, exact, "127.0.0.1", undefined, pin),
    ).rejects.toThrow();
    expect(requests).toBe(1);
    server.setSecureContext({ cert: renewed, key });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 86400_000 });
    await expect(
      connectOrigin(origin, original, undefined, false, exact, "127.0.0.1", undefined, pin),
    ).rejects.toThrow("validity");
    expect(requests).toBe(1);
  } finally {
    vi.useRealTimers();
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("authenticated startup hint refresh uses the saved LAN route without contacting the relay", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const directory = await mkdtemp(join(tmpdir(), "omnesis-direct-refresh-"));
  const files = tlsFiles(directory, "gateway.example.test"),
    certificate = await readFile(files.certFile, "utf8"),
    key = await readFile(files.keyFile, "utf8");
  const f = await fixture();
  let relayConnections = 0;
  f.relay.dataServer.on("connection", () => relayConnections++);
  let localPort = 0;
  const gateway = httpsServer({ cert: certificate, key }, (req, res) => {
    if (req.url === "/ready") {
      res.end("ready");
      return;
    }
    expect(req.url).toBe("/devices/direct-candidates");
    expect(req.headers.host).toBe(new URL(f.gatewayUrl).host);
    if (req.headers.authorization !== "Bearer approved-device") {
      res.writeHead(401);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ version: 1, candidates: [{ address: "192.168.1.20", port: localPort }] }),
    );
  });
  const direct = await listen(gateway);
  localPort = Number(new URL(direct).port);
  try {
    await f.tunnel(direct.replace("http:", "https:"));
    const baseline = relayConnections;
    const network = await import("./network.js"),
      original = network.connectOrigin;
    vi.spyOn(network, "connectOrigin").mockImplementation(
      (origin, ca, signal, opaque, pin, _host, port, spki) =>
        original(origin, ca, signal, opaque, pin, "127.0.0.1", port, spki),
    );
    const { discoverDirectCandidates, pinnedGatewayJson } =
      await import("./google-device-pairing.js");
    const candidate = { publicOrigin: f.gatewayUrl, certificate };
    const saved = [{ address: "192.168.1.20", port: localPort }];
    expect(
      await discoverDirectCandidates(
        candidate,
        "approved-device",
        new AbortController().signal,
        undefined,
        saved,
        tlsSpkiFingerprint(certificate),
      ),
    ).toEqual(saved);
    expect(relayConnections).toBe(baseline);
    await expect(
      discoverDirectCandidates(
        candidate,
        "revoked-device",
        new AbortController().signal,
        undefined,
        saved,
        tlsSpkiFingerprint(certificate),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(relayConnections).toBe(baseline);
    await expect(
      pinnedGatewayJson(candidate, "/devices/pair", {}, new AbortController().signal, undefined, {
        directCandidates: saved,
      }),
    ).rejects.toThrow("authenticated discovery");
  } finally {
    vi.restoreAllMocks();
    await f.close();
    await closeServer(gateway);
    await rm(directory, { recursive: true, force: true });
  }
});
