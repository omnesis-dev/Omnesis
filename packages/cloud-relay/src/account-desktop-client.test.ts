// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter, getEventListeners } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import {
  authorizeAccountDesktop,
  listenForCompletion,
  openAccountBrowser,
} from "./account-desktop-client.js";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock(import("node:child_process"), async (original) => ({ ...(await original()), spawn }));
const relay = "https://relay.example.test",
  opaque = () => randomBytes(32).toString("base64url");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  spawn.mockReset();
  Object.defineProperty(process, "platform", platform);
});
function setup() {
  const controller = new AbortController();
  const operation = {
    operationId: randomUUID(),
    ticket: opaque(),
    authorizeUrl: "",
    connectUrl: `${relay}/_relay/connect`,
    code: "ABCD-EF23",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
  operation.authorizeUrl = `${relay}/_relay/v3/desktop/begin?operationId=${operation.operationId}&ticket=${opaque()}`;
  const approved = {
    status: "approved",
    accountId: "a".repeat(64),
    discoveryToken: "discovery-only",
    expiresAt: operation.expiresAt,
  };
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    Response.json(
      String(url).endsWith("/start")
        ? operation
        : String(url).endsWith("/cancel")
          ? { ok: true }
          : approved,
    ),
  );
  const openBrowser = vi.fn(async () => {}),
    wait = vi.fn(async () => {});
  return {
    controller,
    operation,
    approved,
    fetcher,
    openBrowser,
    wait,
    options: {
      relayUrl: relay,
      nonce: opaque(),
      kind: "collector" as const,
      name: "Fictional laptop",
      signal: controller.signal,
    },
    run() {
      return authorizeAccountDesktop(this.options, {
        fetch: this.fetcher,
        openBrowser: this.openBrowser,
        wait: this.wait,
      });
    },
  };
}
test("browser sign-in binds the native PKCE holder and never sends native credentials in the launch URL", async () => {
  const f = setup();
  f.fetcher
    .mockImplementationOnce(async () => Response.json(f.operation))
    .mockImplementationOnce(async () =>
      Response.json({ status: "pending", expiresAt: f.operation.expiresAt }),
    );
  expect(await f.run()).toEqual(f.approved);
  const body = (index: number) => JSON.parse(String(f.fetcher.mock.calls[index]![1]!.body));
  const start = body(0),
    redeem = body(1);
  expect(start).toEqual({
    nonce: f.options.nonce,
    kind: "collector",
    name: f.options.name,
    challenge: createHash("sha256").update(redeem.verifier).digest("base64url"),
    loopbackPort: expect.any(Number),
  });
  expect(redeem).not.toHaveProperty("completion");
  expect(redeem).toMatchObject({
    operationId: f.operation.operationId,
    ticket: f.operation.ticket,
  });
  expect(f.openBrowser).toHaveBeenCalledWith(f.operation.authorizeUrl, relay + "/");
  expect(f.operation.authorizeUrl).not.toContain(f.operation.ticket);
  expect(f.operation.authorizeUrl).not.toContain(redeem.verifier);
  expect(f.wait).toHaveBeenCalledOnce();
  expect(f.fetcher.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/cancel"))).toBe(false);
});
test("launch origins, paths, repeated query keys and expiry cannot redirect the browser or weaken the operation", async () => {
  const changes = [
    { authorizeUrl: "https://foreign.example.test/_relay/v3/desktop/begin" },
    { authorizeUrl: relay + "/elsewhere" },
    { authorizeUrl: relay + "/_relay/v3/desktop/begin?operationId=x&ticket=y&ticket=z" },
    { expiresAt: Math.floor(Date.now() / 1000) - 1 },
    { expiresAt: Math.floor(Date.now() / 1000) + 600 },
    { connectUrl: "https://foreign.example.test/_relay/connect" },
    { connectUrl: relay + "/_relay/elsewhere" },
  ];
  for (const change of changes) {
    const f = setup();
    Object.assign(f.operation, change);
    await expect(f.run()).rejects.toThrow();
    expect(f.openBrowser).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.at(-1)![0].toString()).toMatch(/\/cancel$/);
  }
  const f = setup();
  const url = new URL(f.operation.authorizeUrl);
  url.searchParams.set("ticket", f.operation.ticket);
  f.operation.authorizeUrl = url.href;
  await expect(f.run()).rejects.toThrow("destination");
});
test("network errors, invalid replies, cancellation and late results never publish discovery credentials", async () => {
  for (const invalid of [
    { status: "approved", token: "management" },
    {
      status: "approved",
      accountId: "a".repeat(64),
      discoveryToken: "x",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    },
    { status: "pending", expiresAt: 1 },
  ]) {
    const f = setup();
    f.fetcher
      .mockImplementationOnce(async () => Response.json(f.operation))
      .mockImplementationOnce(async () => Response.json(invalid));
    await expect(f.run()).rejects.toThrow();
    expect(f.fetcher.mock.calls.at(-1)![0].toString()).toMatch(/\/cancel$/);
  }
  const f = setup();
  f.fetcher
    .mockImplementationOnce(async () => Response.json(f.operation))
    .mockImplementationOnce(async () => {
      f.controller.abort(new Error("Cancelled"));
      return Response.json(f.approved);
    });
  await expect(f.run()).rejects.toThrow("Cancelled");
  expect(getEventListeners(f.controller.signal, "abort")).toHaveLength(0);
  const unavailable = setup();
  unavailable.fetcher.mockResolvedValue(new Response(null, { status: 503 }));
  await expect(unavailable.run()).rejects.toThrow("unavailable");
  const cancelled = setup();
  cancelled.controller.abort();
  await expect(cancelled.run()).rejects.toThrow();
  expect(cancelled.fetcher).not.toHaveBeenCalled();
});
test("the system browser is invoked without a shell and rejects destinations outside the configured Root", async () => {
  const f = setup();
  for (const value of ["darwin", "win32", "linux"]) {
    Object.defineProperty(process, "platform", { value, configurable: true });
    const child = new EventEmitter();
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    await openAccountBrowser(f.operation.authorizeUrl, relay);
    expect(spawn).toHaveBeenLastCalledWith(
      value === "darwin" ? "open" : value === "win32" ? "rundll32" : "xdg-open",
      value === "win32"
        ? ["url.dll,FileProtocolHandler", f.operation.authorizeUrl]
        : [f.operation.authorizeUrl],
      { stdio: "ignore" },
    );
  }
  await expect(openAccountBrowser("https://foreign.example.test", relay)).rejects.toThrow(
    "destination",
  );
  for (const event of ["exit", "error"]) {
    const child = new EventEmitter();
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit(event, event === "exit" ? 1 : new Error("No browser")));
      return child;
    });
    await expect(openAccountBrowser(f.operation.authorizeUrl, relay)).rejects.toThrow();
  }
});

test("closing sign-in cancels a browser launcher that never returns and releases listeners", async () => {
  const f = setup();
  f.openBrowser.mockImplementation(async () => {
    f.controller.abort(new Error("Closed sign-in"));
    await new Promise<void>(() => {});
  });
  await expect(f.run()).rejects.toThrow("Closed sign-in");
  expect(f.fetcher.mock.calls.at(-1)![0].toString()).toMatch(/\/cancel$/);
  expect(getEventListeners(f.controller.signal, "abort")).toHaveLength(0);
});

test("installed defaults use the system browser, bounded polling and the global transport", async () => {
  const f = setup();
  const child = new EventEmitter();
  spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
  f.fetcher
    .mockImplementationOnce(async () => Response.json(f.operation))
    .mockImplementationOnce(async () =>
      Response.json({ status: "pending", expiresAt: f.operation.expiresAt }),
    );
  vi.stubGlobal("fetch", f.fetcher);
  expect(await authorizeAccountDesktop(f.options)).toEqual(f.approved);
  expect(spawn).toHaveBeenCalledOnce();
});
test("an expired operation cannot poll after returning from the browser and cancellation errors preserve the original failure", async () => {
  const f = setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  f.openBrowser.mockImplementation(async () => {
    vi.setSystemTime((f.operation.expiresAt + 1) * 1000);
  });
  f.fetcher
    .mockImplementationOnce(async () => Response.json(f.operation))
    .mockRejectedValueOnce(new Error("Cancellation unavailable"));
  await expect(f.run()).rejects.toThrow("expired");
});

test("the connect code is printed before the browser opens and a missing browser leaves the code as the way in", async () => {
  const f = setup();
  const printed: unknown[] = [];
  const options = {
    ...f.options,
    onConnectCode: vi.fn((value: unknown) => {
      printed.push(value);
      expect(f.openBrowser).not.toHaveBeenCalled();
    }),
  };
  f.openBrowser.mockRejectedValue(new Error("No browser"));
  const proof = { type: "google" as const, idToken: "header.payload.signature", salt: opaque() };
  const approved = { ...f.approved, signInProof: proof, credentialPublicKey: "public-key" };
  f.fetcher
    .mockImplementationOnce(async () => Response.json(f.operation))
    .mockImplementationOnce(async () => Response.json(approved));
  expect(
    await authorizeAccountDesktop(options, {
      fetch: f.fetcher,
      openBrowser: f.openBrowser,
      wait: f.wait,
    }),
  ).toEqual(approved);
  expect(printed).toEqual([{ connectUrl: `${relay}/_relay/connect`, code: "ABCD-EF23" }]);
  expect(f.openBrowser).toHaveBeenCalledOnce();
  expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/cancel"))).toBe(false);
});
test("a relay's short connect address is passed on for display and never requested or opened", async () => {
  const f = setup(),
    onConnectCode = vi.fn();
  Object.assign(f.operation, { connectShortUrl: "https://front.example.test/connect" });
  f.fetcher
    .mockImplementationOnce(async () => Response.json(f.operation))
    .mockImplementationOnce(async () => Response.json(f.approved));
  await authorizeAccountDesktop(
    { ...f.options, onConnectCode },
    { fetch: f.fetcher, openBrowser: f.openBrowser, wait: f.wait },
  );
  expect(onConnectCode).toHaveBeenCalledExactlyOnceWith({
    connectUrl: `${relay}/_relay/connect`,
    connectShortUrl: "https://front.example.test/connect",
    code: "ABCD-EF23",
  });
  expect(f.fetcher.mock.calls.every(([url]) => new URL(String(url)).origin === relay)).toBe(true);
  expect(JSON.stringify(f.openBrowser.mock.calls)).not.toContain("front.example.test");
});
test("start replies without a well-formed connect code are refused", async () => {
  for (const change of [
    { code: "abcd-efgh" },
    { connectUrl: undefined },
    { connectShortUrl: "http://front.example.test/connect" },
    { connectShortUrl: "https://name:secret@front.example.test/connect" },
    { connectShortUrl: "front.example.test/connect" },
    { connectShortUrl: "https://front.example.test/" + "c".repeat(200) },
    { connectShortUrl: 7 },
  ]) {
    const f = setup();
    Object.assign(f.operation, change);
    await expect(f.run()).rejects.toThrow();
    expect(f.openBrowser).not.toHaveBeenCalled();
  }
});

/** A raw request, so a test can choose the Host header and method a browser would not. */
function call(port: number, path: string, options: { host?: string; method?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host: options.host ?? `127.0.0.1:${port}` },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("the browser's loopback callback hands this desktop the completion, once, and nothing else reaches it", async () => {
  const f = setup();
  const completion = opaque();
  const callback = (port: number, query: string) => `/omnesis/callback?${query}`;
  let port = 0;
  f.fetcher
    .mockImplementationOnce(async (_url, init) => {
      port = JSON.parse(String(init!.body)).loopbackPort;
      return Response.json(f.operation);
    })
    .mockImplementationOnce(async () => {
      const valid = `operationId=${f.operation.operationId}&completion=${completion}`;
      for (const [path, options] of [
        [callback(port, valid), { method: "POST" }],
        [callback(port, valid), { host: `localhost:${port}` }],
        [`/elsewhere?${valid}`, {}],
        [callback(port, `${valid}&extra=1`), {}],
        [callback(port, `operationId=${randomUUID()}&completion=${completion}`), {}],
        [callback(port, `operationId=${f.operation.operationId}&completion=short`), {}],
      ] as const)
        expect((await call(port, path, options)).status).toBe(404);
      const accepted = await call(port, callback(port, valid));
      expect(accepted.status).toBe(200);
      expect(accepted.body).toContain("You can close this page");
      return Response.json({ status: "pending", expiresAt: f.operation.expiresAt });
    });
  expect(await f.run()).toEqual(f.approved);
  const redeem = JSON.parse(String(f.fetcher.mock.calls[2]![1]!.body));
  expect(redeem.completion).toBe(completion);
  // Single use: the listener is gone once the sign-in is over.
  await expect(call(port, callback(port, "x=1"))).rejects.toThrow();
});

test("a second callback is refused, and a desktop that cannot listen still signs in without a loopback port", async () => {
  const listener = await listenForCompletion();
  const operationId = randomUUID();
  // Before the operation is known, nothing is accepted.
  const query = `/omnesis/callback?operationId=${operationId}&completion=${opaque()}`;
  expect((await call(listener.port, query)).status).toBe(404);
  listener.expect(operationId);
  expect((await call(listener.port, query)).status).toBe(200);
  const first = listener.completion();
  expect(first).toBeDefined();
  expect(
    (await call(listener.port, query.replace(/completion=[^&]+/, `completion=${opaque()}`))).status,
  ).toBe(404);
  expect(listener.completion()).toBe(first);
  listener.close();

  const f = setup();
  expect(
    await authorizeAccountDesktop(f.options, {
      fetch: f.fetcher,
      openBrowser: f.openBrowser,
      wait: f.wait,
      listen: async () => {
        throw new Error("EADDRNOTAVAIL");
      },
    }),
  ).toEqual(f.approved);
  expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body))).not.toHaveProperty("loopbackPort");
});
