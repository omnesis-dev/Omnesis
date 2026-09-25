// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway behind a reverse proxy that terminates TLS — the documented
 * public-domain topology: `OMNESIS_BIND=127.0.0.1` keeps the gateway off
 * every other interface, `OMNESIS_TRUST_PROXY=true` lets it read the client
 * address the proxy appends, and the proxy's origin is the gateway's public
 * base URL.
 *
 * The proxy here is a small Node server standing in for Caddy or nginx: its
 * own certificate on the front, the gateway's self-signed one accepted on
 * the loopback hop, plain requests and WebSocket upgrades forwarded, and
 * `X-Forwarded-For` appended the way those proxies append it. What the suite
 * proves is the gateway's side of the arrangement: it answers through the
 * proxy, a phone pairing against the public origin gets system trust while
 * the loopback address stays pinned, a collector holds its WebSocket through
 * the proxy, and the per-address limiters and their loopback exemption see
 * the proxy's client rather than the proxy.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GatewayWsClient } from "@omnesis/gateway-client";
import {
  MultiCollectorHarness,
  getFreePort,
  isCollectorOnline,
  waitForCondition,
} from "./multi-collector-harness.js";
import type { Duplex } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const PUBLIC_HOST = "gateway.example.test";
/**
 * Clients the fake proxy reports as remote for particular requests; every
 * connection the harness makes, the collector's WebSocket included, really
 * arrives from loopback.
 */
const COLLECTOR_PEER = "203.0.113.10";
const PAIRING_PEER = "203.0.113.20";
const OTHER_PAIRING_PEER = "203.0.113.21";
const LOGIN_PEER = "203.0.113.30";
/** Header the fake proxy strips and uses as the address it accepted the connection from. */
const PEER_OVERRIDE_HEADER = "x-e2e-peer";

interface ProxyResponse {
  status: number;
  body: string;
}

function mintProxyCertificate(dir: string): { cert: string; key: string } {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      `/CN=${PUBLIC_HOST}`,
      "-addext",
      `subjectAltName=DNS:${PUBLIC_HOST}`,
      "-keyout",
      join(dir, "proxy.key"),
      "-out",
      join(dir, "proxy.crt"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return {
    cert: readFileSync(join(dir, "proxy.crt"), "utf8"),
    key: readFileSync(join(dir, "proxy.key"), "utf8"),
  };
}

/** The address the proxy accepted the connection from, with the test's override. */
function peerOf(req: IncomingMessage): string {
  const override = req.headers[PEER_OVERRIDE_HEADER];
  if (typeof override === "string" && override) return override;
  return req.socket.remoteAddress ?? "unknown";
}

/** Forwarded headers the way Caddy and nginx set them: the peer appended to what arrived. */
function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  const peer = peerOf(req);
  const incoming = req.headers["x-forwarded-for"];
  const previous = typeof incoming === "string" ? incoming : undefined;
  return {
    "x-forwarded-for": previous ? `${previous}, ${peer}` : peer,
    "x-forwarded-proto": "https",
    "x-forwarded-host": req.headers.host ?? PUBLIC_HOST,
  };
}

function startProxy(material: { cert: string; key: string }, gatewayPort: number, port: number) {
  const upstream = { host: "127.0.0.1", port: gatewayPort, rejectUnauthorized: false };
  const server = https.createServer(material, (req: IncomingMessage, res: ServerResponse) => {
    const { [PEER_OVERRIDE_HEADER]: _peer, ...headers } = req.headers;
    const outbound = https.request(
      {
        ...upstream,
        method: req.method,
        path: req.url,
        headers: { ...headers, ...forwardedHeaders(req) },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    outbound.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(outbound);
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const forwarded = forwardedHeaders(req);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] ?? "";
      const lower = name.toLowerCase();
      if (lower === PEER_OVERRIDE_HEADER || lower in forwarded) continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ""}`);
    }
    for (const [name, value] of Object.entries(forwarded)) lines.push(`${name}: ${value}`);
    const target = tls.connect(upstream, () => {
      target.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
  });
  return new Promise<https.Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** A non-loopback IPv4 address of this host, when it has one to prove the bind on. */
function lanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

describe("gateway behind a TLS-terminating reverse proxy", () => {
  let harness: MultiCollectorHarness;
  let proxy: https.Server;
  let proxyPort: number;
  let publicOrigin: string;
  let materialDir: string;

  /** A request through the proxy, addressed by the public name. */
  function viaProxy(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      token?: string;
      peer?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<ProxyResponse> {
    return new Promise((resolve, reject) => {
      const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
      const req = https.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          servername: PUBLIC_HOST,
          rejectUnauthorized: false,
          method: init.method ?? "GET",
          path,
          headers: {
            host: `${PUBLIC_HOST}:${proxyPort}`,
            ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
            ...(payload ? { "content-type": "application/json" } : {}),
            ...(init.peer ? { [PEER_OVERRIDE_HEADER]: init.peer } : {}),
            ...(init.headers ?? {}),
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  beforeAll(async () => {
    proxyPort = await getFreePort();
    publicOrigin = `https://${PUBLIC_HOST}:${proxyPort}`;
    harness = new MultiCollectorHarness({
      extraGatewayEnv: {
        OMNESIS_BIND: "127.0.0.1",
        OMNESIS_TRUST_PROXY: "true",
        OMNESIS_PUBLIC_BASE_URL: publicOrigin,
      },
    });
    await harness.start();
    materialDir = mkdtempSync(join(tmpdir(), "omnesis-proxy-e2e-"));
    proxy = await startProxy(mintProxyCertificate(materialDir), harness.gatewayPort, proxyPort);
  }, 120_000);

  afterAll(async () => {
    if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await harness?.destroy();
    if (materialDir) rmSync(materialDir, { recursive: true, force: true });
  });

  test.skipIf(!lanAddress())("the gateway answers on loopback only", async () => {
    const direct = await fetch(`${harness.gatewayUrl}/health`);
    expect(direct.status).toBe(200);
    await expect(
      fetch(`https://${lanAddress()}:${harness.gatewayPort}/health`, {
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toMatchObject({ cause: { code: "ECONNREFUSED" } });
  });

  test("the health check and an authenticated read pass through the proxy", async () => {
    const health = await viaProxy("/health");
    expect(health.status).toBe(200);
    const served = JSON.parse(health.body) as { version: string };
    const direct = (await (await fetch(`${harness.gatewayUrl}/health`)).json()) as {
      version: string;
    };
    expect(served.version).toBe(direct.version);

    const whoami = await viaProxy("/whoami", { token: harness.bootstrapToken });
    expect(whoami.status).toBe(200);
  });

  test("the public name is the proxy's to cover, not the gateway's own certificate's", async () => {
    const status = await viaProxy("/admin/tls", { token: harness.bootstrapToken });
    expect(status.status).toBe(200);
    const snapshot = JSON.parse(status.body) as {
      served: { uncoveredHosts: string[] };
      proxiedHosts?: string[];
    };
    expect(snapshot.served.uncoveredHosts).toEqual([]);
    expect(snapshot.proxiedHosts).toEqual([PUBLIC_HOST]);
  });

  test("a pairing QR for the public origin selects system trust; the loopback address stays pinned", async () => {
    const minted = await viaProxy("/admin/devices/pair", {
      method: "POST",
      token: harness.bootstrapToken,
      body: { name: "Maya's phone", kind: "ios" },
    });
    expect(minted.status).toBe(200);
    const { pairingCode } = JSON.parse(minted.body) as { pairingCode: string };

    const publicQr = await viaProxy("/admin/devices/pair-qr", {
      method: "POST",
      token: harness.bootstrapToken,
      body: { pairingCode, gatewayUrl: publicOrigin, trustMode: "auto" },
    });
    expect(publicQr.status).toBe(200);
    const publicPayload = JSON.parse(
      (JSON.parse(publicQr.body) as { qrPayload: string }).qrPayload,
    ) as { v: number; gatewayUrl: string; tls?: { mode: string } };
    expect(publicPayload.v).toBe(4);
    expect(publicPayload.gatewayUrl).toBe(publicOrigin);
    expect(publicPayload.tls).toEqual({ mode: "system" });

    const loopbackQr = await viaProxy("/admin/devices/pair-qr", {
      method: "POST",
      token: harness.bootstrapToken,
      body: { pairingCode, gatewayUrl: harness.gatewayUrl, trustMode: "auto" },
    });
    expect(loopbackQr.status).toBe(200);
    const loopbackPayload = JSON.parse(
      (JSON.parse(loopbackQr.body) as { qrPayload: string }).qrPayload,
    ) as { v: number; fingerprint?: string; tls?: unknown };
    expect(loopbackPayload.v).toBe(3);
    expect(loopbackPayload.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(loopbackPayload.tls).toBeUndefined();
  });

  test("a collector pairs and holds its WebSocket through the proxy", async () => {
    const minted = await viaProxy("/admin/devices/pair", {
      method: "POST",
      token: harness.bootstrapToken,
      body: { name: "studio-collector", kind: "collector" },
    });
    expect(minted.status).toBe(200);
    const { pairingCode } = JSON.parse(minted.body) as { pairingCode: string };

    const capabilities = {
      hostname: "studio.example.com",
      platform: "linux",
      hostableSourceTypes: [],
      memberScopedParams: {},
    };
    const redeemed = await viaProxy("/devices/pair", {
      method: "POST",
      peer: COLLECTOR_PEER,
      body: { pairingCode, capabilities },
    });
    expect(redeemed.status).toBe(200);
    const { token, device } = JSON.parse(redeemed.body) as {
      token: string;
      device: { id: string };
    };

    const ws = new GatewayWsClient(`https://127.0.0.1:${proxyPort}`, token, { capabilities });
    ws.connect();
    try {
      await waitForCondition(
        async () => ws.isAuthenticated() && (await isCollectorOnline(harness, device.id)),
        15_000,
        "collector online through the proxy",
      );
    } finally {
      ws.disconnect();
    }
    await waitForCondition(
      async () => !(await isCollectorOnline(harness, device.id)),
      15_000,
      "collector offline after disconnecting",
    );
  });

  test("the pairing limiter counts the proxy's client, and a client cannot rename itself", async () => {
    const attempt = (peer: string, headers: Record<string, string> = {}) =>
      viaProxy("/devices/pair", {
        method: "POST",
        peer,
        headers,
        body: { pairingCode: "000000-not-a-code" },
      });
    // Fired together: the burst bucket refills one attempt every six seconds,
    // so a sequential run under load could earn the eleventh attempt a token.
    const burst = await Promise.all(Array.from({ length: 11 }, () => attempt(PAIRING_PEER)));
    expect(burst.map((r) => r.status).sort()).toEqual([...Array<number>(10).fill(400), 429]);

    // A different client keeps its own bucket.
    expect((await attempt(OTHER_PAIRING_PEER)).status).toBe(400);
    // The exhausted client's own X-Forwarded-For entry does not move it to another bucket.
    expect((await attempt(PAIRING_PEER, { "x-forwarded-for": OTHER_PAIRING_PEER })).status).toBe(
      429,
    );
  });

  test("the loopback exemption covers the gateway host, not every connection the proxy relays", async () => {
    const login = (peer?: string) =>
      viaProxy("/portal/api/login", {
        method: "POST",
        ...(peer ? { peer } : {}),
        body: { token: "not-the-token", deviceName: "Browser" },
      });
    const burst = await Promise.all(Array.from({ length: 11 }, () => login(LOGIN_PEER)));
    expect(burst.map((r) => r.status).sort()).toEqual([...Array<number>(10).fill(401), 429]);

    // The harness itself reaches the proxy over loopback: exempt, so still refused for the token alone.
    const local = await Promise.all(Array.from({ length: 12 }, () => login()));
    expect(local.map((r) => r.status)).toEqual(Array<number>(12).fill(401));
  });
});
