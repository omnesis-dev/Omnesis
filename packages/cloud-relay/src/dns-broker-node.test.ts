// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FileBrokerStore, createDnsBrokerServer } from "./dns-broker-node.js";
import type { AddressInfo } from "node:net";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-dns-broker-node-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

test("the file store persists privately and survives a restart", async () => {
  const file = join(directory, "registry", "broker.json");
  const store = await FileBrokerStore.open(file);
  expect(await store.get("name:a")).toBeUndefined();
  await store.put("name:a", { owner: 1 });
  await store.put("lease:b", { id: 2 });
  await store.delete("missing");
  const value = (await store.get("name:a")) as { owner: number };
  value.owner = 9;
  expect(await store.get("name:a")).toEqual({ owner: 1 });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const reopened = await FileBrokerStore.open(file);
  expect([...(await reopened.list("lease:"))]).toEqual([["lease:b", { id: 2 }]]);
  await reopened.delete("lease:b");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "name:a": { owner: 1 } });
});

test("an unreadable or oversized store refuses to open", async () => {
  const file = join(directory, "broker.json");
  await writeFile(file, "[1, 2]");
  await expect(FileBrokerStore.open(file)).rejects.toThrow("Invalid DNS broker registry");
  await writeFile(file, "");
  await truncate(file, 64 * 1024 * 1024 + 1);
  await expect(FileBrokerStore.open(file)).rejects.toThrow("too large");
  await mkdir(join(directory, "folder"));
  await expect(FileBrokerStore.open(join(directory, "folder"))).rejects.toMatchObject({
    code: "EISDIR",
  });
});

async function serve(options: Partial<Parameters<typeof createDnsBrokerServer>[0]> = {}) {
  const seen: {
    method: string;
    path: string;
    type: string | null;
    auth: string | null;
    body: string;
  }[] = [];
  const broker = {
    handle: vi.fn(async (request: Request) => {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        type: request.headers.get("content-type"),
        auth: request.headers.get("authorization"),
        body: await request.text(),
      });
      return Response.json({ ok: true }, { status: 201, headers: { "cache-control": "no-store" } });
    }),
    expire: vi.fn(async () => undefined),
  };
  const served = createDnsBrokerServer({ broker, ...options });
  served.server.listen(0, "127.0.0.1");
  await once(served.server, "listening");
  const url = `http://127.0.0.1:${(served.server.address() as AddressInfo).port}`;
  return { served, broker, seen, url };
}

test("requests reach the broker's fetch handler with their method, path, headers and body", async () => {
  const { served, seen, url } = await serve();
  try {
    const health = await fetch(`${url}/_dns/v2/health?x=1`);
    expect(health.status).toBe(201);
    expect(health.headers.get("cache-control")).toBe("no-store");
    await fetch(`${url}/_dns/v2/import`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: '{"entries":[]}',
    });
    expect(seen).toEqual([
      { method: "GET", path: "/_dns/v2/health", type: "", auth: "", body: "" },
      {
        method: "POST",
        path: "/_dns/v2/import",
        type: "application/json",
        auth: "Bearer token",
        body: '{"entries":[]}',
      },
    ]);
    const large = await fetch(`${url}/_dns/v2/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1_048_577),
    });
    expect(large.status).toBe(413);
  } finally {
    await served.close();
  }
  await served.close();
});

test("version 1 routes go to the receipt broker when one is configured", async () => {
  const legacy = createServer((req, res) => res.end(`legacy ${req.url}`));
  const { served, seen, url } = await serve({ legacy });
  try {
    expect(await (await fetch(`${url}/healthz`)).text()).toBe("legacy /healthz");
    expect(await (await fetch(`${url}/_dns/v1/challenge`, { method: "POST" })).text()).toBe(
      "legacy /_dns/v1/challenge",
    );
    expect(seen).toEqual([]);
  } finally {
    await served.close();
  }
});

test("admission limits, broker failures and broken responses end the request", async () => {
  const { served, broker, url } = await serve({
    loginLimits: { maxConcurrent: 8, maxPerMinute: 60, maxPerMinutePerClient: 1 },
  });
  try {
    expect((await fetch(`${url}/_dns/v2/health`)).status).toBe(201);
    expect((await fetch(`${url}/_dns/v2/health`)).status).toBe(429);
  } finally {
    await served.close();
  }
  const failing = await serve();
  try {
    failing.broker.handle.mockRejectedValueOnce(new Error("unexpected"));
    expect((await fetch(`${failing.url}/_dns/v2/health`)).status).toBe(400);
    failing.broker.handle.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull: (controller) => controller.error(new Error("broken body")),
        }),
      ),
    );
    // Headers were already sent: the response just ends, empty.
    expect(await (await fetch(`${failing.url}/_dns/v2/health`)).text()).toBe("");
  } finally {
    await failing.served.close();
  }
  expect(broker.handle).toHaveBeenCalledTimes(1);
});

test("expired leases are removed on a timer, and a failed close is reported", async () => {
  const timers: (() => void)[] = [];
  vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    timers.push(callback);
    return { unref() {} };
  }) as never);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const broker = { handle: vi.fn(), expire: vi.fn().mockRejectedValue(new Error("later")) };
  const served = createDnsBrokerServer({ broker });
  timers[0]!();
  expect(broker.expire).toHaveBeenCalledTimes(1);
  await served.close();
  const failing = createDnsBrokerServer({ broker });
  failing.server.listen(0, "127.0.0.1");
  await once(failing.server, "listening");
  const close = failing.server.close.bind(failing.server);
  vi.spyOn(failing.server, "close").mockImplementation(((callback: (error?: Error) => void) =>
    close(() => callback(new Error("close failed")))) as never);
  await expect(failing.close()).rejects.toThrow("close failed");
});

test("a socket error closes only that connection", async () => {
  const { served, url } = await serve();
  try {
    const [socket] = (await Promise.all([
      once(served.server, "connection"),
      fetch(`${url}/_dns/v2/health`),
    ])) as unknown as [[import("node:net").Socket]];
    socket[0].emit("error", new Error("reset"));
    expect(socket[0].destroyed).toBe(true);
    expect((await fetch(`${url}/_dns/v2/health`)).status).toBe(201);
  } finally {
    await served.close();
  }
});
