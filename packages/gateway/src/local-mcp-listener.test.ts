// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  arrivedOnLocalMcp,
  LOCAL_MCP_BIND_ADDRESSES,
  LocalMcpListener,
  localMcpPort,
} from "./local-mcp-listener.js";

const open: LocalMcpListener[] = [];
const blockers: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((listener) => listener.close()));
  await Promise.all(
    blockers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

type Handle = (request: Request, env: unknown) => Response | Promise<Response>;

function listener(
  handle = vi.fn<Handle>(
    (_request, env) => new Response(arrivedOnLocalMcp(env) ? "local" : "unmarked", { status: 200 }),
  ),
) {
  const servers: Server[] = [];
  const created = new LocalMcpListener({
    port: 0,
    handle,
    portalOrigin: () => "https://localhost:17650",
    onServer: (server) => servers.push(server),
  });
  open.push(created);
  return { created, handle, servers };
}

/** A raw request, so the Host header can name anything. */
function send(
  port: number,
  path: string,
  { host = `localhost:${port}`, method = "GET", address = "127.0.0.1" } = {},
): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: address, port, path, method, headers: { Host: host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            ...(res.headers.location ? { location: res.headers.location } : {}),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("the MCP address for agents on this computer", () => {
  test("listens on loopback alone, never on another interface", async () => {
    const { created, servers } = listener();
    const state = await created.start();
    expect(state).toMatchObject({ state: "listening" });
    const port = (state as { port: number }).port;
    expect(state).toMatchObject({ url: `http://localhost:${port}` });
    const bound = servers
      .filter((server) => server.listening)
      .map((server) => (server.address() as { address: string }).address);
    expect(bound.length).toBeGreaterThan(0);
    for (const address of bound) expect(LOCAL_MCP_BIND_ADDRESSES).toContain(address);
    // This machine's own network address, where it has one, is refused outright.
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
    if (lan) {
      const refused = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: lan, port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(false);
        });
        socket.once("error", () => resolve(true));
      });
      expect(refused).toBe(true);
    }
  });

  test("answers only as a loopback host, so a page that rebinds its name to 127.0.0.1 gets nothing", async () => {
    const { created, handle } = listener();
    const { port } = (await created.start()) as { port: number };
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
      expect((await send(port, "/mcp", { host, method: "POST" })).status).toBe(200);
    for (const host of [`attacker.example:${port}`, "localhost:9", `192.168.0.20:${port}`])
      expect((await send(port, "/mcp", { host, method: "POST" })).status).toBe(421);
    expect(handle).toHaveBeenCalledTimes(3);
  });

  test("serves an MCP client's paths alone, marked as from this machine", async () => {
    const { created, handle } = listener();
    const { port } = (await created.start()) as { port: number };
    for (const path of [
      "/mcp",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/oauth/register",
      "/oauth/authorize?client_id=x",
      "/oauth/consent?request=x",
      "/oauth/authorize/complete?request=x",
      "/oauth/token",
      "/portal/css/style.css",
      "/portal/js/oauth-consent-controller.js",
    ]) {
      const answer = await send(port, path);
      expect(answer, path).toMatchObject({ status: 200, body: "local" });
    }
    handle.mockClear();
    for (const path of [
      "/admin/devices",
      "/oauth/callback",
      "/health",
      "/ws",
      "/portal/api/access",
      "/.well-known/omnesis-startup",
      "/portal/%2e%2e/admin",
    ]) {
      const answer = await send(port, path);
      expect(answer.status, path).toBeGreaterThanOrEqual(300);
      expect(answer.status, path).not.toBe(200);
    }
    expect(handle).not.toHaveBeenCalled();
  });

  test("sends the portal's own pages to the gateway's HTTPS loopback address", async () => {
    const { created, handle } = listener();
    const { port } = (await created.start()) as { port: number };
    expect(await send(port, "/portal/settings/access/connect?x=1")).toMatchObject({
      status: 302,
      location: "https://localhost:17650/portal/settings/access/connect?x=1",
    });
    // A write never follows a redirect: it is simply not found.
    expect((await send(port, "/portal/api/login", { method: "POST" })).status).toBe(404);
    expect(handle).not.toHaveBeenCalled();
  });

  test("a port another program holds is reported, and the gateway goes on", async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const taken = (blocker.address() as { port: number }).port;
    const busy = new LocalMcpListener({
      port: taken,
      handle: () => new Response("never"),
      portalOrigin: () => "https://localhost:17650",
    });
    open.push(busy);
    expect(await busy.start()).toEqual({ state: "port-in-use", port: taken });
    expect(busy.state()).toEqual({ state: "port-in-use", port: taken });
  });

  test("one not started says why", () => {
    expect(LocalMcpListener.notStarted("off").state()).toEqual({ state: "off" });
    expect(LocalMcpListener.notStarted("container").state()).toEqual({ state: "container" });
  });

  test("its port is the configured one, else the gateway's plus one", () => {
    expect(localMcpPort(undefined, 7600)).toBe(7601);
    expect(localMcpPort({ gateway: { localMcp: { port: 9001 } } }, 7600)).toBe(9001);
    expect(localMcpPort(undefined, 0)).toBe(0);
    expect(localMcpPort(undefined, 65_535)).toBe(0);
    // The environment wins, as it does for the gateway's own port; anything unreadable is ignored.
    expect(
      localMcpPort({ gateway: { localMcp: { port: 9001 } } }, 7600, {
        OMNESIS_LOCAL_MCP_PORT: "0",
      }),
    ).toBe(0);
    expect(localMcpPort(undefined, 7600, { OMNESIS_LOCAL_MCP_PORT: "nope" })).toBe(7601);
  });
});

describe("the MCP address for agents on this computer, under contention and shutdown", () => {
  // All of 127.0.0.0/8 answers on Linux; macOS has only 127.0.0.1 until an alias is added.
  test.skipIf(process.platform !== "linux")(
    "another program on the port's IPv6 loopback is the port in use, and nothing is left listening",
    async () => {
      const blocker = createServer();
      blockers.push(blocker);
      // Stand-ins for 127.0.0.1 and ::1 that need no IPv6: the second is already held.
      await new Promise<void>((resolve) => blocker.listen({ host: "127.0.0.2", port: 0 }, resolve));
      const taken = (blocker.address() as { port: number }).port;
      const servers: Server[] = [];
      const busy = new LocalMcpListener({
        port: taken,
        handle: () => new Response("never"),
        portalOrigin: () => "https://localhost:17650",
        onServer: (server) => servers.push(server),
        bindAddresses: ["127.0.0.1", "127.0.0.2"],
      });
      open.push(busy);
      expect(await busy.start()).toEqual({ state: "port-in-use", port: taken });
      expect(servers.some((server) => server.listening)).toBe(false);
    },
  );

  test("an address this machine does not have is skipped", async () => {
    const servers: Server[] = [];
    const partial = new LocalMcpListener({
      port: 0,
      handle: () => new Response("ok"),
      portalOrigin: () => "https://localhost:17650",
      onServer: (server) => servers.push(server),
      // TEST-NET-1 is never assigned to a local interface.
      bindAddresses: ["127.0.0.1", "192.0.2.1"],
    });
    open.push(partial);
    expect(await partial.start()).toMatchObject({ state: "listening" });
    expect(servers.filter((server) => server.listening)).toHaveLength(1);
  });

  test("closing lets a request under way finish within the drain, and closes once", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { created } = listener(
      vi.fn<Handle>(async () => {
        await held;
        return new Response("finished");
      }),
    );
    const { port } = (await created.start()) as { port: number };
    const answer = send(port, "/mcp", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closing = created.close(5_000);
    expect(created.close()).toBe(closing);
    release();
    expect(await answer).toMatchObject({ status: 200, body: "finished" });
    await closing;
  });
});
