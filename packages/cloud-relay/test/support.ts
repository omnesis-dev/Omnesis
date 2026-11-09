// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createHttpsServer, request as requestHttps } from "node:https";
import { connect as connectTls } from "node:tls";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SignJWT } from "jose";
import { parseWebSocketAuthProtocolHeader } from "@omnesis/core";
import { WebSocketServer, WebSocket } from "ws";
import { RelayAccounts } from "../src/accounts.js";
import { RelaySessions, localIdentityProvider } from "../src/identity.js";
import { createCloudRelay, type CloudRelayOptions } from "../src/server.js";
import { GatewayTunnel } from "../src/tunnel-client.js";
import { createRelayClientProxy } from "../src/client-proxy.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function localToken(
  secret: Uint8Array,
  subject = "fictional-account",
  ttl = 3600,
): Promise<string> {
  return new SignJWT({ sub: subject })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("omnesis-local-test")
    .setAudience("omnesis-cloud-relay")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(secret);
}

export async function fixture(extra: Partial<CloudRelayOptions> = {}) {
  const key = randomBytes(32);
  const accounts = new RelayAccounts(":memory:");
  const sessions = new RelaySessions(randomBytes(32));
  const relay = createCloudRelay({
    accounts,
    sessions,
    identity: localIdentityProvider(key, "127.0.0.1"),
    gatewayIdentity: localIdentityProvider(key, "127.0.0.1"),
    ...extra,
  });
  const url = await listen(relay.server);
  relay.dataServer.listen(0, "127.0.0.1");
  await once(relay.dataServer, "listening");
  const dataPort = (relay.dataServer.address() as AddressInfo).port;
  const gatewayUrl = `https://gateway.example.test:${dataPort}`;
  const login = async (
    subject = "fictional-account",
  ): Promise<{ token: string; accountId: string; expiresAt: number }> => {
    const response = await fetch(`${url}/_relay/v1/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: await localToken(key, subject) }),
    });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
    return response.json();
  };
  const session = await login();
  const tunnels: GatewayTunnel[] = [];
  return {
    url,
    key,
    accounts,
    sessions,
    login,
    session,
    relay,
    dataPort,
    gatewayUrl,
    register(gatewayId = randomUUID(), account = session.accountId) {
      accounts.registerBinding(account, {
        gatewayId,
        publicOrigin: gatewayUrl,
        certificate: "test-only-routing-metadata",
        identityToken: "test-only-routing-metadata",
      });
      return gatewayId;
    },
    probe() {
      const socket = connectTls({
        host: "127.0.0.1",
        port: dataPort,
        servername: "gateway.example.test",
      });
      socket.on("error", () => {});
      return socket;
    },
    proxy(gateway: { certificate: string; fingerprint: string }) {
      return createRelayClientProxy({
        gatewayUrl,
        gatewayCa: gateway.certificate,
        gatewayFingerprint: gateway.fingerprint,
        gatewayConnectHost: "127.0.0.1",
      });
    },
    async tunnel(localGatewayUrl: string, gatewayId = randomUUID(), token = session.token) {
      const account = (await sessions.verify(token)).accountId;
      accounts.registerBinding(account, {
        gatewayId,
        publicOrigin: gatewayUrl,
        certificate: "test-only-routing-metadata",
        identityToken: "test-only-routing-metadata",
      });
      const tunnel = new GatewayTunnel({
        relayUrl: url,
        gatewayUrl: localGatewayUrl,
        gatewayId,
        session: async () => token,
        reconnectMs: 20,
      });
      tunnels.push(tunnel);
      tunnel.start();
      await until(async () => {
        return new Promise<boolean>((resolve) => {
          const req = requestHttps(
            gatewayUrl + "/ready",
            {
              hostname: "127.0.0.1",
              servername: "gateway.example.test",
              rejectUnauthorized: false,
            },
            (res) => {
              res.resume();
              resolve(res.statusCode === 200);
            },
          );
          req.on("error", () => resolve(false));
          req.end();
        });
      });
      return tunnel;
    },
    async close() {
      for (const tunnel of tunnels) tunnel.stop();
      await relay.close();
      accounts.close();
    },
  };
}

export async function until(
  predicate: () => boolean | Promise<boolean>,
  timeout = 5000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function echoGateway(
  hostname = "gateway.example.test",
  authorized: (value: string | undefined) => boolean = (value) => value === "Bearer fixture-token",
) {
  const requests: Array<{ path?: string; headers: Record<string, unknown>; body: Buffer }> = [];
  const directory = await mkdtemp(join(tmpdir(), "omnesis-relay-echo-"));
  const files = tlsFiles(directory, hostname);
  const certificate = await readFile(files.certFile, "utf8");
  const key = await readFile(files.keyFile, "utf8");
  const fingerprint = new X509Certificate(certificate).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
  const server = createHttpsServer({ cert: certificate, key }, (req, res) => {
    void (async () => {
      const body: Buffer[] = [];
      for await (const chunk of req) body.push(Buffer.from(chunk));
      requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(body) });
      if (req.url === "/ready" || req.url === "/health") {
        res.end("ready");
        return;
      }
      if (!authorized(req.headers.authorization)) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        return;
      }
      if (req.url === "/disconnect") {
        req.socket.destroy();
        return;
      }
      if (req.url === "/binary") {
        res.writeHead(201, { "content-type": "application/octet-stream" });
        res.end(Buffer.concat(body));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "x-omnesis-relay-session": "must-not-escape",
      });
      res.end(
        JSON.stringify({
          path: req.url,
          ...(req.url === "/whoami" ? { deviceId: "00000000-0000-4000-8000-000000000001" } : {}),
          method: req.method,
          body: Buffer.concat(body).toString(),
          authorization: req.headers.authorization,
        }),
      );
    })().catch(() => res.destroy());
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (
      !authorized(req.headers.authorization) &&
      !authorized(
        `Bearer ${parseWebSocketAuthProtocolHeader(req.headers["sec-websocket-protocol"])}`,
      )
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    requests.push({ path: req.url, headers: req.headers, body: head });
    sockets.handleUpgrade(req, socket, head, (ws) =>
      ws.on("message", (message, binary) => ws.send(message, { binary })),
    );
  });
  const url = (await listen(server)).replace("http:", "https:");
  return {
    url,
    certificate,
    fingerprint,
    requests,
    server,
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function openWs(
  url: string,
  headers: Record<string, string> = {},
): Promise<WebSocket> {
  const ws = new WebSocket(url.replace(/^http/, "ws"), { headers });
  const ready = url.endsWith("/_relay/v1/tunnel") ? once(ws, "message") : undefined;
  if (ready) void ready.catch(() => {});
  await once(ws, "open");
  if (ready) await ready;
  return ws;
}

export function tlsFiles(
  directory: string,
  hostname = "localhost",
): { keyFile: string; certFile: string } {
  const keyFile = join(directory, "tls-key.pem");
  const certFile = join(directory, "tls-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      `subjectAltName=DNS:${hostname},DNS:localhost,IP:127.0.0.1,IP:::1`,
    ],
    { stdio: "ignore" },
  );
  return { keyFile, certFile };
}

/** Corrupt a public test certificate's ASN.1 time without changing its parseable key or host. */
export function malformedDateCertificate(certificate: string, which: "from" | "to"): string {
  const der = Buffer.from(new X509Certificate(certificate).raw);
  const dates = [...der.toString("latin1").matchAll(/\x17\x0d[0-9]{12}Z/g)];
  const position = dates[which === "from" ? 0 : 1]?.index;
  if (position === undefined) throw new Error("Test certificate requires two ASN.1 UTC times");
  der.write("991399000000Z", position + 2, "ascii");
  return new X509Certificate(der).toString();
}
