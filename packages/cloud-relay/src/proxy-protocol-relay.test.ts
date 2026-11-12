// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fixture, listen, closeServer, tlsFiles } from "../test/support.js";
import { ProxyProtocolPeers } from "./proxy-protocol.js";
import { relayedClientAddress } from "./relay-client-address.js";

beforeEach(() => vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1"));
afterEach(() => vi.unstubAllEnvs());

/** The front layer's address. These run on Linux, which alone routes all of 127/8 to loopback. */
const FRONT = "127.0.0.9";

function proxyHeader(source: string): Buffer {
  const family = source.includes(":") ? "TCP6" : "TCP4";
  const destination = family === "TCP6" ? "2001:db8::1" : "192.0.2.1";
  return Buffer.from(`PROXY ${family} ${source} ${destination} 50000 443\r\n`);
}

/** A TCP connection from `from` to `port` that has already written `prefix`. */
async function dial(port: number, from: string, prefix?: Buffer): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port, localAddress: from });
  await once(socket, "connect");
  if (prefix) socket.write(prefix);
  return socket;
}

/** POSTs a sign-in with a token no identity provider accepts, over `socket`. */
function login(socket: Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ idToken: "not-a-real-token" });
    const req = httpRequest(
      {
        createConnection: () => socket,
        path: "/_relay/v1/login",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          connection: "close",
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode!));
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

/** Everything the server sent before closing, for requests that never parse as HTTP. */
async function rawReply(socket: Socket, request: string): Promise<string> {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("error", () => {});
  socket.write(request);
  await once(socket, "close");
  return Buffer.concat(chunks).toString();
}

const onLinux = test.runIf(process.platform === "linux");

onLinux(
  "the control listener counts sign-ins by the front layer's client, and requires its header",
  async () => {
    const f = await fixture({
      proxyProtocolPeers: ProxyProtocolPeers.parse(FRONT),
      loginLimits: { maxConcurrent: 8, maxPerMinute: 60, maxPerMinutePerClient: 2 },
    });
    const port = Number(new URL(f.url).port);
    try {
      const from = async (client: string) => login(await dial(port, FRONT, proxyHeader(client)));
      // Every request arrives from the front's own address; the header tells them apart.
      expect([await from("198.51.100.1"), await from("198.51.100.1")]).toEqual([401, 401]);
      expect(await from("198.51.100.1")).toBe(429);
      expect(await from("198.51.100.2")).toBe(401);
      expect(await from("2001:db8:7::1")).toBe(401);
      expect(await from("2001:db8:7::2")).toBe(401);
      // One IPv6 subscriber is one /64.
      expect(await from("2001:db8:7::3")).toBe(429);

      // The front without its header: closed before HTTP reads a byte.
      expect(await rawReply(await dial(port, FRONT), "GET /healthz HTTP/1.1\r\n\r\n")).toBe("");
      // Anyone else's header is not read: it is not HTTP, as it never was.
      expect(
        await rawReply(
          await dial(port, "127.0.0.1", proxyHeader("198.51.100.3")),
          "GET /healthz HTTP/1.1\r\nHost: relay\r\n\r\n",
        ),
      ).toMatch(/^HTTP\/1\.1 400 /);
      // And a direct client without one is served as before.
      expect((await fetch(`${f.url}/healthz`)).status).toBe(200);
    } finally {
      await f.close();
    }
  },
);

onLinux(
  "the data listener tells the gateway the front layer's client for each stream",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnesis-relay-proxy-"));
    const files = tlsFiles(directory, "gateway.example.test");
    const gateway = createHttpsServer(
      { cert: await readFile(files.certFile), key: await readFile(files.keyFile) },
      (req, res) => res.end(relayedClientAddress(req.socket) ?? "none"),
    );
    const gatewayUrl = (await listen(gateway)).replace("http:", "https:");
    const f = await fixture({ proxyProtocolPeers: ProxyProtocolPeers.parse(`${FRONT}/32`) });
    try {
      await f.tunnel(gatewayUrl);
      const ask = (socket: Socket) =>
        new Promise<string>((resolve, reject) => {
          const req = httpsRequest(
            {
              createConnection: () =>
                connectTls({
                  socket,
                  servername: "gateway.example.test",
                  rejectUnauthorized: false,
                }),
              path: "/who",
              headers: { connection: "close" },
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => (body += chunk));
              res.once("end", () => resolve(body));
            },
          );
          req.once("error", reject);
          req.end();
        });
      expect(await ask(await dial(f.dataPort, FRONT, proxyHeader("203.0.113.5")))).toBe(
        "203.0.113.5",
      );
      expect(await ask(await dial(f.dataPort, FRONT, proxyHeader("2001:db8::5")))).toBe(
        "2001:db8::5",
      );
      // A direct client is reported as its own peer.
      expect(await ask(await dial(f.dataPort, "127.0.0.1"))).toBe("127.0.0.1");
      // A header from anyone else is not a ClientHello; the router drops the connection.
      await expect(
        ask(await dial(f.dataPort, "127.0.0.1", proxyHeader("203.0.113.6"))),
      ).rejects.toThrow();
      // The front without its header is refused before the ClientHello is read.
      await expect(ask(await dial(f.dataPort, FRONT))).rejects.toThrow();
    } finally {
      await f.close();
      await closeServer(gateway);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
