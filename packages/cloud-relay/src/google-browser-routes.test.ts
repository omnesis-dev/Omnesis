// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { googleBrowserFixture } from "../test/google-browser-fixture.js";
import { listen, until } from "../test/support.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions, accountId } from "./identity.js";
import { createCloudRelay } from "./server.js";
import { gatewayKeyIdentity } from "./gateway-key-auth.js";
import { GoogleBrowserRoutes } from "./google-browser-routes.js";
import { LoginAdmission } from "./admission.js";
import { RelayError } from "./tunnels.js";
import { GOOGLE_BROWSER_PATH } from "./google-browser-contract.js";

let directory: string;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "google-browser-routes-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const stop of cleanup.splice(0).reverse()) await stop();
  await rm(directory, { recursive: true, force: true });
});
async function fixture(options: { maxLogins?: number; sessionTtl?: number } = {}) {
  const f = await googleBrowserFixture(directory);
  const accounts = new RelayAccounts(join(directory, "accounts.sqlite")),
    sessions = new RelaySessions(randomBytes(32), options.sessionTtl ?? 3600);
  accounts.registerKeyBinding(f.account, f.binding, true);
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: f.owner.relayOrigin,
    googleBrowser: f.configuration,
    loginLimits: { maxConcurrent: 1, maxPerMinute: options.maxLogins ?? 60 },
  });
  const origin = await listen(relay.server);
  cleanup.push(async () => {
    await relay.close();
    accounts.close();
    f.broker.close();
  });
  const session = await sessions.issue(gatewayKeyIdentity(f.registration, f.now + 3600));
  const http = (path: string, init?: RequestInit) =>
    fetch(origin + GOOGLE_BROWSER_PATH + path, init);
  const post = (path: string, body: unknown, token = session.token) =>
    http(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { ...f, accounts, sessions, relay, origin, session, http, post };
}

test("public capabilities contain only installation-wide client IDs while method/path/JSON limits fail closed", async () => {
  const f = await fixture();
  const config = await f.http("/config");
  expect(config.status).toBe(200);
  expect(config.headers.get("cache-control")).toBe("no-store");
  expect(config.headers.get("referrer-policy")).toBe("no-referrer");
  const text = await config.text();
  expect(text).toContain("fixture-owner-client");
  expect(text).not.toContain("synthetic-secret");
  expect(text).not.toContain(f.ownerKeys.privateKey);
  for (const [path, method] of [
    ["/config", "POST"],
    ["/begin", "POST"],
    ["/callback", "POST"],
    ["/start", "GET"],
    ["/redeem", "GET"],
  ])
    expect((await f.http(path!, { method: method! })).status).toBe(405);
  expect((await f.http("/unknown")).status).toBe(404);
  expect((await fetch(f.origin + "/unrelated")).status).toBe(404);
  expect((await f.http("/start", { method: "POST" })).status).toBe(401);
  expect(
    (
      await f.http("/start", {
        method: "POST",
        headers: { authorization: `Bearer ${f.session.token}` },
        body: "{}",
      })
    ).status,
  ).toBe(415);
  for (const body of ["bad-json", ""])
    expect(
      (
        await f.http("/start", {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.session.token}`,
            "content-type": "application/json",
          },
          body,
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await f.http("/start", {
        method: "POST",
        headers: { authorization: `Bearer ${f.session.token}`, "content-type": "application/json" },
        body: "x".repeat(8193),
      })
    ).status,
  ).toBe(413);
  expect((await f.post("/start", {})).status).toBe(400);
});

test("raw owner authorization rejects aliases, missing or malformed bindings and cross-account restored rows", async () => {
  const f = await fixture();
  const google = {
    issuer: "https://accounts.google.com",
    subject: "synthetic-google-user",
    expiresAt: f.now + 3600,
  };
  const user = await f.sessions.issue(google);
  expect((await f.post("/start", {}, user.token)).status).toBe(403);
  f.accounts.linkGoogleAccount(accountId(google), f.account);
  expect((await f.post("/start", {}, user.token)).status).toBe(403);
  const read = vi.spyOn(f.accounts, "gatewayBinding");
  read.mockReturnValueOnce({ ...f.binding, identityToken: "legacy-binding" });
  expect((await f.post("/start", {})).status).toBe(403);
  const other = await f.sessions.issue(
    gatewayKeyIdentity({ ...f.registration, gatewayId: randomUUID() }, f.now + 3600),
  );
  read.mockReturnValueOnce(f.binding);
  expect((await f.post("/start", {}, other.token)).status).toBe(403);
});

test("browser begin accepts exactly one signed-operation ticket and never a return URL override", async () => {
  const f = await fixture();
  const pending = f.request();
  const started = await f.post("/start", pending.input);
  expect(started.status).toBe(200);
  const result = (await started.json()) as { authorizeUrl: string };
  const launch = new URL(result.authorizeUrl);
  for (const search of [
    "",
    "?operationId=invalid&ticket=invalid",
    launch.search + "&ticket=duplicate",
    launch.search + "&returnTo=https://other.example.test",
    "?operationId=" + pending.input.operationId,
  ])
    expect((await f.http("/begin" + search, { redirect: "manual" })).status).toBe(400);
  const allowed = await f.http("/begin" + launch.search, { redirect: "manual" });
  expect(allowed.status).toBe(303);
  expect(allowed.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect((await f.http("/callback?state=unknown", { redirect: "manual" })).status).toBe(400);
  expect(
    (
      await f.post("/redeem", {
        operationId: pending.input.operationId,
        result: "a".repeat(43),
        redemptionSecret: pending.secret,
      })
    ).status,
  ).toBe(403);
});

test("admission bounds unauthenticated attempts and oversized URLs without interpreting callback data", async () => {
  const f = await fixture({ maxLogins: 1 });
  expect((await f.http("/begin", { redirect: "manual" })).status).toBe(400);
  expect((await f.http("/begin", { redirect: "manual" })).status).toBe(429);
  // The default HTTP parser can reject the request before the broker sees it.
  const path = "/callback?state=" + "x".repeat(16384);
  const response = await f.http(path, { redirect: "manual" });
  expect([414, 431]).toContain(response.status);
});

test("the broker enforces its own URL bound even when the HTTP parser permits larger headers", async () => {
  const f = await googleBrowserFixture(directory);
  const routes = new GoogleBrowserRoutes(
    {
      ...f.configuration,
      authenticate: () => Promise.resolve(f.owner),
    },
    new LoginAdmission(),
  );
  const server = createServer({ maxHeaderSize: 32768 }, (req, res) => {
    void routes.handle(req, res).catch((error: unknown) => {
      res.writeHead(error instanceof RelayError ? error.status : 500);
      res.end();
    });
  });
  const origin = await listen(server);
  cleanup.push(async () => {
    routes.close();
    f.broker.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  expect((await fetch(origin + GOOGLE_BROWSER_PATH + "/config")).status).toBe(200);
  expect(
    (await fetch(origin + GOOGLE_BROWSER_PATH + "/callback?state=" + "x".repeat(16384))).status,
  ).toBe(414);
});

test("a disconnected callback aborts the provider exchange and does not write a late response", async () => {
  const f = await fixture(),
    pending = f.request();
  const started = (await (await f.post("/start", pending.input)).json()) as {
    authorizeUrl: string;
  };
  const start = new URL(started.authorizeUrl);
  const launched = await f.http("/begin" + start.search, { redirect: "manual" });
  const callback = f.providerCallback(launched.headers.get("location")!);
  let entered!: (signal: AbortSignal) => void;
  const waiting = new Promise<AbortSignal>((resolve) => {
    entered = resolve;
  });
  f.exchange.mockImplementationOnce(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        entered(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const controller = new AbortController();
  const response = f.http("/callback" + callback.search, {
    redirect: "manual",
    headers: { cookie: launched.headers.get("set-cookie")!.split(";")[0]! },
    signal: controller.signal,
  });
  const rejected = expect(response).rejects.toThrow();
  const signal = await waiting;
  controller.abort();
  await rejected;
  await until(() => signal.aborted);
  const original = f.relay.server.listeners("request");
  f.relay.server.prependOnceListener("request", (_req, res) =>
    res.end("synthetic pre-ended response"),
  );
  expect(await (await f.http("/config")).text()).toBe("synthetic pre-ended response");
  expect(f.relay.server.listeners("request")).toHaveLength(original.length);
});

test("slow authenticated JSON peers are closed at the bounded body deadline", async () => {
  const f = await fixture();
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(f.origin).port) });
  socket.on("error", () => {});
  await once(socket, "connect");
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  socket.write(
    `POST ${GOOGLE_BROWSER_PATH}/start HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.session.token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`,
  );
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(5001);
  await closed;
  vi.useRealTimers();
});
