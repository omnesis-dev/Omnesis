// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { request as httpsRequest } from "node:https";
import { generateSelfSigned } from "../tls.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { tailnetCallerOf, type TailnetCaller } from "./caller.js";
import {
  TAILNET_TRANSPORT_HEADER,
  startTailnetSocketServer,
  tailnetSocketPath,
  type TailnetSocketServer,
} from "./socket-server.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const ownerCaller: TailnetCaller = {
  via: "tailnet",
  client: "100.64.0.2:51000",
  peer: {
    nodeId: "n1",
    nodeName: "maya-laptop",
    userId: "7",
    login: "maya@example.com",
    sameOwner: true,
  },
};

let tls: { cert: string; key: string };
beforeAll(async () => {
  tls = await generateSelfSigned();
});
let rawSeen: string[][];
let dir: string;
let server: TailnetSocketServer;
let seen: Array<{ url: string; caller: TailnetCaller | null; header: unknown }>;
let upgrades: Array<{ url: string; caller: TailnetCaller | null }>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ts-sock-"));
  seen = [];
  rawSeen = [];
  upgrades = [];
  server = await startTailnetSocketServer({
    path: tailnetSocketPath(join(dir, "tailscale")),
    ...(process.platform === "win32" ? { tls } : {}),
    listener: (req, res) => {
      rawSeen.push(req.rawHeaders);
      seen.push({
        url: req.url ?? "",
        caller: tailnetCallerOf(req),
        header: req.headers["x-omnesis-tailnet"],
      });
      res.end("ok");
    },
    upgrade: (req: IncomingMessage, socket) => {
      upgrades.push({ url: req.url ?? "", caller: tailnetCallerOf(req) });
      socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
    },
  });
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function send(
  path: string,
  headers: Record<string, string | string[]>,
  token: string | null = server.transport?.token ?? null,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = server.transport ? httpsRequest : httpRequest;
    const req = request(
      {
        socketPath: server.path,
        path,
        ...(server.transport ? { ca: tls.cert, servername: "localhost" } : {}),
        headers: { ...(token ? { [TAILNET_TRANSPORT_HEADER]: token } : {}), ...headers },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function upgrade(path: string, caller: unknown, opened?: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const write = () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: omnesis.example-net.ts.net\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Omnesis-Tailnet: ${encode(caller)}\r\n${server.transport ? `${TAILNET_TRANSPORT_HEADER}: ${server.transport.token}\r\n` : ""}\r\n`,
      );
    };
    const sock = server.transport
      ? tlsConnect({ socket: connect(server.path), ca: tls.cert, servername: "localhost" }, write)
      : connect(server.path, write);
    sock.on("error", reject);
    let data = "";
    sock.on("data", (d) => {
      data += d;
      if (data.includes("\r\n")) opened?.();
    });
    sock.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
  });
}

describe("admission", () => {
  test("serves a tailnet request as the HTTPS request the caller made, with the caller recorded", async () => {
    const res = await send("/portal/?a=1", {
      host: "omnesis.example-net.ts.net",
      "x-omnesis-tailnet": encode(ownerCaller),
    });
    expect(res).toEqual({ status: 200, body: "ok" });
    expect(rawSeen[0]?.some((value) => value.toLowerCase().startsWith("x-omnesis-tailnet"))).toBe(
      false,
    );
    expect(seen).toEqual([
      {
        url: "https://omnesis.example-net.ts.net/portal/?a=1",
        caller: ownerCaller,
        header: undefined,
      },
    ]);
  });

  test("refuses a request without, or with a malformed, caller header", async () => {
    expect((await send("/x", { host: "omnesis" })).status).toBe(400);
    expect((await send("/x", { host: "omnesis", "x-omnesis-tailnet": "%%%" })).status).toBe(400);
    expect(
      (await send("/x", { host: "omnesis", "x-omnesis-tailnet": encode({ via: "tailnet" }) }))
        .status,
    ).toBe(400);
    expect(seen).toEqual([]);
  });

  test("a public request reaches only the public paths", async () => {
    const pub = encode({ via: "public", client: "198.51.100.4:61000" });
    expect(
      (await send("/portal/", { host: "omnesis.example-net.ts.net", "x-omnesis-tailnet": pub }))
        .status,
    ).toBe(404);
    expect(
      (
        await send("/admin/tailscale", {
          host: "omnesis.example-net.ts.net",
          "x-omnesis-tailnet": pub,
        })
      ).status,
    ).toBe(404);
    expect(seen).toEqual([]);
    expect(
      (await send("/mcp", { host: "omnesis.example-net.ts.net", "x-omnesis-tailnet": pub })).status,
    ).toBe(200);
    expect(seen[0]?.caller).toEqual({ via: "public", client: "198.51.100.4:61000" });
  });

  test("refuses a bad host", async () => {
    expect(
      (await send("/x", { host: "evil host", "x-omnesis-tailnet": encode(ownerCaller) })).status,
    ).toBe(400);
  });

  test("tailnet upgrades reach the WebSocket handler; public ones never do", async () => {
    expect(await upgrade("/device/ws", ownerCaller)).toContain("101");
    expect(upgrades).toEqual([
      { url: "https://omnesis.example-net.ts.net/device/ws", caller: ownerCaller },
    ]);
    expect(await upgrade("/mcp", { via: "public", client: "198.51.100.4:1" })).toContain("404");
    expect(await upgrade("/device/ws", { via: "nope" })).toContain("400");
    expect(upgrades).toHaveLength(1);
  });
});

describe("the socket file", () => {
  test.skipIf(process.platform === "win32")("is private to this account", () => {
    expect(statSync(server.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(server.path, "..")).mode & 0o777).toBe(0o700);
  });

  test.skipIf(process.platform === "win32")(
    "replaces a stale socket but never another file",
    async () => {
      const path = server.path;
      // Simulate a crash: the socket file is left behind.
      await new Promise<void>((r) => server.server.close(() => r()));
      const next = await startTailnetSocketServer({ path, listener: (_q, s) => s.end("again") });
      await next.close();
      const regular = join(dir, "not-a-socket");
      writeFileSync(regular, "keep");
      await expect(startTailnetSocketServer({ path: regular, listener: () => {} })).rejects.toThrow(
        /not a socket/,
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "refuses a directory that is a link to somewhere else",
    async () => {
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere);
      const link = join(dir, "linked");
      symlinkSync(elsewhere, link);
      await expect(
        startTailnetSocketServer({ path: join(link, "gateway.sock"), listener: () => {} }),
      ).rejects.toThrow(/not a directory owned by this account/);
    },
  );

  test("keeps idle connections longer than the helper does", () => {
    expect(server.server.keepAliveTimeout).toBeGreaterThan(90_000);
    expect(server.server.headersTimeout).toBeGreaterThan(server.server.keepAliveTimeout);
  });
});

describe("tailnetSocketPath", () => {
  test.skipIf(process.platform === "win32")(
    "uses the feature directory when short, a per-config runtime directory otherwise",
    () => {
      expect(tailnetSocketPath("/var/lib/omnesis/tailscale", {})).toBe(
        "/var/lib/omnesis/tailscale/gateway.sock",
      );
      const long = `/home/someone/${"x".repeat(120)}/tailscale`;
      const runtime = mkdtempSync(join(tmpdir(), "rt-"));
      mkdirSync(runtime, { recursive: true });
      const chosen = tailnetSocketPath(long, { XDG_RUNTIME_DIR: runtime });
      expect(chosen.startsWith(runtime)).toBe(true);
      expect(chosen).toBe(tailnetSocketPath(long, { XDG_RUNTIME_DIR: runtime }));
      expect(chosen).not.toBe(tailnetSocketPath(`${long}2`, { XDG_RUNTIME_DIR: runtime }));
      rmSync(runtime, { recursive: true, force: true });
      vi.unstubAllEnvs();
    },
  );
});

describe("authenticated local TLS", () => {
  beforeEach(async () => {
    if (server.transport) return;
    await server.close();
    server = await startTailnetSocketServer({
      path: tailnetSocketPath(join(dir, "secure")),
      tls,
      listener: (req, res) => {
        rawSeen.push(req.rawHeaders);
        res.end("ok");
      },
    });
  });
  test("requires the helper token and removes its parsed and raw transport headers", async () => {
    const headers = { host: "omnesis", "x-omnesis-tailnet": encode(ownerCaller) };
    expect((await send("/x", headers, null)).status).toBe(403);
    expect((await send("/x", headers, "0".repeat(64))).status).toBe(403);
    expect(
      (
        await send("/x", {
          ...headers,
          [TAILNET_TRANSPORT_HEADER]: [server.transport!.token, server.transport!.token],
        })
      ).status,
    ).toBe(403);
    expect((await send("/x", headers)).status).toBe(200);
    expect(rawSeen).toHaveLength(1);
    expect(rawSeen[0]?.some((value) => value.toLowerCase().startsWith("x-omnesis-tailnet"))).toBe(
      false,
    );
  });
  test.runIf(process.platform === "win32")(
    "a Windows endpoint is a unique pipe and refuses unauthenticated startup",
    async () => {
      expect(server.path.startsWith(String.raw`\\.\pipe\omnesis-tailnet-`)).toBe(true);
      expect(tailnetSocketPath(dir)).not.toBe(tailnetSocketPath(dir));
      await expect(
        startTailnetSocketServer({ path: tailnetSocketPath(dir), listener: () => {} }),
      ).rejects.toThrow(/TLS-authenticated named pipe/);
    },
  );
});

test("shutdown cuts an upgraded connection and waits for its actual close", async () => {
  await server.close();
  const accepted = Promise.withResolvers<void>();
  server = await startTailnetSocketServer({
    path: tailnetSocketPath(join(dir, "upgrade-drain")),
    ...(process.platform === "win32" ? { tls } : {}),
    listener: (_req, res) => res.end(),
    upgrade: (_req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      accepted.resolve();
    },
  });
  const delivered = Promise.withResolvers<void>();
  const response = upgrade("/device/ws", ownerCaller, () => delivered.resolve());
  await accepted.promise;
  await delivered.promise;
  const closing = server.close(10);
  expect(server.close()).toBe(closing);
  await closing;
  expect(await response).toContain("101");
  expect(server.server.listening).toBe(false);
  expect(server.closedConfirmed).toBe(true);
});
