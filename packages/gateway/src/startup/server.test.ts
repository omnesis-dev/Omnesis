// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { createSecureContext, type TLSSocket } from "node:tls";
import { X509Certificate, createHash } from "node:crypto";
import { Socket, type AddressInfo } from "node:net";
import { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveTlsBundle } from "../tls.js";
import { StartupManager } from "./manager.js";
import { StartupServer, STARTUP_STATUS_PATH } from "./server.js";

describe("startup HTTPS dispatcher", () => {
  const directory = mkdtempSync(join(tmpdir(), "omnesis-startup-server-"));
  let tls: Awaited<ReturnType<typeof resolveTlsBundle>>;
  beforeAll(async () => {
    tls = await resolveTlsBundle({ configDir: directory });
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  async function fixture() {
    const manager = new StartupManager();
    const listener = new StartupServer(manager);
    await listener.listen({ port: 0, hostname: "127.0.0.1", cert: tls.cert, key: tls.key });
    const port = (listener.server.address() as AddressInfo).port;
    const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
      new Promise<{
        status: number;
        headers: import("node:http").IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const req = httpsRequest(
          { hostname: "127.0.0.1", port, path, method, headers, rejectUnauthorized: false },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () =>
              resolve({ status: response.statusCode!, headers: response.headers, body }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    return {
      manager,
      listener,
      port,
      get,
      close: () => listener.shutdown.close(listener.server, 1000),
    };
  }

  it("serves navigation to any destination without exposing APIs or claiming health", async () => {
    const f = await fixture();
    try {
      for (const path of [
        "/",
        "/portal/search?q=fictional",
        "/documents/fictional",
        "/unknown/deep/route",
      ]) {
        const response = await f.get(path, { Accept: "text/html" });
        expect(response.status).toBe(200);
        expect(response.body).toContain("gateway is starting up");
        expect(response.headers["content-security-policy"]).not.toContain("unsafe-inline");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
      }
      for (const path of ["/health", "/status", "/portal/api/session", "/admin/config"]) {
        const response = await f.get(path);
        expect(response.status).toBe(503);
        expect(JSON.parse(response.body).code).toBe("GATEWAY_STARTING");
        expect(response.headers["retry-after"]).toBe("1");
      }
      expect((await f.get("/portal/search", { Accept: "text/html" }, "POST")).status).toBe(503);
      expect((await f.get("/health", { Accept: "text/html" })).status).toBe(503);
      expect((await f.get("/portal/", {}, "HEAD")).body).toBe("");
    } finally {
      await f.close();
    }
  });

  it("reports fresh snapshots and hands the same socket to the normal app without losing peer identity", async () => {
    const f = await fixture();
    try {
      const originalServer = f.listener.server;
      f.manager.start("launcher");
      let response = await f.get(STARTUP_STATUS_PATH);
      const first = JSON.parse(response.body);
      expect(first.state).toBe("starting");
      f.manager.succeed("launcher");
      response = await f.get(STARTUP_STATUS_PATH);
      expect(JSON.parse(response.body).sequence).toBeGreaterThan(first.sequence);
      let mounted = false;
      f.listener.activate(
        (request, env) =>
          Response.json(
            { path: new URL(request.url).pathname, peer: env.incoming.socket.remoteAddress },
            { status: 401 },
          ),
        () => {
          mounted = true;
        },
      );
      expect(mounted).toBe(true);
      expect(f.listener.server).toBe(originalServer);
      response = await f.get("/portal/search?q=fictional");
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ path: "/portal/search", peer: "127.0.0.1" });
      expect((await f.get(STARTUP_STATUS_PATH)).status).toBe(200);
      expect(() =>
        f.listener.activate(
          () => new Response(),
          () => {},
        ),
      ).toThrow("already active");
    } finally {
      await f.close();
    }
  });

  it("selects a public SNI certificate while still serving startup and retains direct TLS", async () => {
    const f = await fixture();
    const other = await resolveTlsBundle({ configDir: join(directory, "public") });
    const publicContext = createSecureContext({ cert: other.cert, key: other.key });
    f.listener.setSniCallback((hostname, done) =>
      done(null, hostname === "public.example.org" ? publicContext : undefined),
    );
    const request = (servername: string) =>
      new Promise<{ fingerprint: string; body: string }>((resolve, reject) => {
        const req = httpsRequest(
          {
            hostname: "127.0.0.1",
            port: f.port,
            servername,
            rejectUnauthorized: false,
            headers: { Accept: "text/html" },
          },
          (response) => {
            const peer = (response.socket as TLSSocket).getPeerCertificate();
            const certificate = new X509Certificate(peer.raw);
            const fingerprint = createHash("sha256").update(certificate.raw).digest("hex");
            let body = "";
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => resolve({ fingerprint, body }));
          },
        );
        req.once("error", reject);
        req.end();
      });
    try {
      const direct = await request("localhost");
      const cloud = await request("public.example.org");
      expect(direct.fingerprint).toBe(tls.fingerprintSha256);
      expect(cloud.fingerprint).toBe(other.fingerprintSha256);
      expect(cloud.body).toContain("gateway is starting up");
      expect(f.manager.snapshot().state).toBe("starting");
    } finally {
      await f.close();
    }
  });

  it("rejects WebSockets during boot, then attaches the application's upgrade handler", async () => {
    const f = await fixture();
    const clients: WebSocket[] = [];
    const wss = new WebSocketServer({ noServer: true });
    try {
      const early = new WebSocket(`wss://127.0.0.1:${f.port}/device`, {
        rejectUnauthorized: false,
      });
      clients.push(early);
      const status = await new Promise<number>((resolve, reject) => {
        early.once("unexpected-response", (_req, response) => {
          response.resume();
          resolve(response.statusCode!);
        });
        early.once("error", reject);
      });
      expect(status).toBe(503);
      early.terminate();
      wss.on("connection", (socket) => socket.send("ready"));
      f.listener.activate(
        () => new Response("normal"),
        (server) => {
          server.on("upgrade", (request, socket, head) =>
            wss.handleUpgrade(request, socket, head, (client) =>
              wss.emit("connection", client, request),
            ),
          );
        },
      );
      const late = new WebSocket(`wss://127.0.0.1:${f.port}/device`, { rejectUnauthorized: false });
      clients.push(late);
      const message = await new Promise<string>((resolve, reject) => {
        late.once("message", (value) => resolve(String(value)));
        late.once("error", reject);
      });
      expect(message).toBe("ready");
    } finally {
      for (const client of clients) client.terminate();
      wss.close();
      await f.close();
    }
  });

  it("gates alternate-listener upgrades until activation and closes admission during shutdown", async () => {
    const f = await fixture();
    const accept = vi.fn();
    const attempt = () => {
      const peer = new Socket();
      const request = new IncomingMessage(peer);
      const socket = new PassThrough();
      let response = "";
      socket.on("data", (chunk: Buffer) => {
        response += chunk.toString();
      });
      try {
        // The alternate listener invokes the application's handler only inside
        // this callback, matching the embedded Tailscale upgrade bridge.
        f.listener.admitUpgrade(request, socket, accept);
        return response;
      } finally {
        peer.destroy();
        socket.destroy();
      }
    };
    try {
      expect(attempt()).toMatch(/^HTTP\/1\.1 503 /);
      expect(accept).not.toHaveBeenCalled();
      f.listener.activate(
        () => new Response("normal"),
        () => {},
      );
      expect(attempt()).toBe("");
      expect(accept).toHaveBeenCalledOnce();
      const closing = f.close();
      // Admission closes synchronously, before the listener drain settles.
      expect(attempt()).toMatch(/^HTTP\/1\.1 503 /);
      expect(accept).toHaveBeenCalledOnce();
      await closing;
      expect(attempt()).toMatch(/^HTTP\/1\.1 503 /);
      expect(accept).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it("keeps failure details sanitized and disallows activation after shutdown or required failure", async () => {
    for (const stop of [true, false]) {
      const f = await fixture();
      try {
        f.manager.start("launcher");
        if (stop) f.manager.stop();
        else f.manager.fail("launcher");
        expect(() =>
          f.listener.activate(
            () => new Response(),
            () => {},
          ),
        ).toThrow("no longer active");
        const response = await f.get(STARTUP_STATUS_PATH);
        const body = JSON.parse(response.body);
        expect(body.state).toBe(stop ? "stopping" : "failed");
        expect(response.body).not.toMatch(/stack|SQL|token|password|configDir/);
      } finally {
        await f.close();
      }
    }
  });

  it("refuses an occupied listener without disturbing its owner", async () => {
    const f = await fixture();
    const second = new StartupServer(new StartupManager());
    try {
      await expect(
        second.listen({ port: f.port, hostname: "127.0.0.1", cert: tls.cert, key: tls.key }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect((await f.get(STARTUP_STATUS_PATH)).status).toBe(200);
    } finally {
      await f.close();
    }
  });
});
