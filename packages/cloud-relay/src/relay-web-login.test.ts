// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { listen, closeServer } from "../test/support.js";
import { LoginAdmission } from "./admission.js";
import { localIdentityProvider } from "./identity.js";
import { RelayError } from "./tunnels.js";
import { RelayWebLogin, type RelayWebLoginOptions } from "./relay-web-login.js";

const origin = "https://relay.example.test";
const secret = "fictional-relay-backend-secret";
const key = randomBytes(32);
const identity = localIdentityProvider(key, "127.0.0.1");
const transport = vi.fn<typeof fetch>();
const accountCookie = "__Host-omnesis-account=fixture";
const accountBrowser = () => ({
  begin: vi.fn<RelayWebLoginOptions["accountBrowser"]["begin"]>(async () => ({})),
  complete: vi.fn<RelayWebLoginOptions["accountBrowser"]["complete"]>(async () => ({
    cookie: accountCookie,
    location: "/_relay/account",
  })),
  failed: vi.fn<RelayWebLoginOptions["accountBrowser"]["failed"]>(
    () => "/_relay/account?failed=google",
  ),
});
const webLogin = {
  clientId: "fictional-web-client",
  clientSecret: secret,
  publicOrigin: origin,
  identity,
  fetch: transport,
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  transport.mockReset();
  for (const close of cleanup.splice(0)) await close();
});
async function setup(
  overrides: Partial<RelayWebLoginOptions> = {},
  // One test address stands in for many browsers, so it gets the whole global rate.
  admission = new LoginAdmission(8, 60, { maxPerMinute: 60 }),
) {
  const browser = accountBrowser();
  const service = new RelayWebLogin(
    { ...webLogin, accountBrowser: browser, ...overrides },
    admission,
  );
  const server = createServer((req, res) => {
    void service
      .handle(req, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch((error: unknown) => {
        res.writeHead(error instanceof RelayError ? error.status : 500);
        res.end();
      });
  });
  const url = await listen(server);
  cleanup.push(async () => {
    service.close();
    await closeServer(server);
  });
  return { service, url, browser };
}
async function begin(url: string) {
  const response = await fetch(`${url}/_relay/web/start`, {
    method: "POST",
    headers: { origin },
    redirect: "manual",
  });
  expect(response.status).toBe(303);
  return {
    authorization: new URL(response.headers.get("location")!),
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
  };
}
async function signed(nonce: string, subject = "fictional-account") {
  return new SignJWT({ nonce })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("omnesis-local-test")
    .setAudience("omnesis-cloud-relay")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}
async function callback(base: string, authorization: URL, cookie?: string, extra = "") {
  return fetch(
    `${base}/_relay/web/callback?state=${authorization.searchParams.get("state")}&code=fictional-code${extra}`,
    { headers: cookie === undefined ? {} : { cookie }, redirect: "manual" },
  );
}
async function googleAnswers(authorization: URL) {
  transport.mockResolvedValue(
    Response.json({
      id_token: await signed(authorization.searchParams.get("nonce")!),
      token_type: "Bearer",
    }),
  );
}

test("Google PKCE hands the verified token to account services and clears its own state", async () => {
  const f = await setup();
  const { authorization, cookie } = await begin(f.url);
  expect(authorization.origin).toBe("https://accounts.google.com");
  expect(authorization.searchParams.get("redirect_uri")).toBe(`${origin}/_relay/web/callback`);
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(authorization.href).not.toContain(secret);
  await googleAnswers(authorization);
  const response = await callback(f.url, authorization, cookie);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`${origin}/_relay/account`);
  expect(response.headers.getSetCookie()).toEqual([
    expect.stringContaining("Max-Age=0"),
    accountCookie,
  ]);
  const [endpoint, init] = transport.mock.calls[0]!;
  expect(endpoint).toBe("https://oauth2.googleapis.com/token");
  expect((init!.body as URLSearchParams).get("client_secret")).toBe(secret);
  expect((init!.body as URLSearchParams).get("code_verifier")).toHaveLength(64);
  const [idToken, nonce, context] = f.browser.complete.mock.calls[0]!;
  expect(idToken).toContain(".");
  expect(nonce).toBe(authorization.searchParams.get("nonce"));
  expect(context).toBeUndefined();
  const replay = await callback(f.url, authorization, cookie);
  expect(replay.headers.get("location")).toBe("/_relay/account?failed=google");
  expect(transport).toHaveBeenCalledOnce();
});

test("an operation's context and committed nonce reach Google and come back unchanged", async () => {
  const f = await setup(),
    committed = randomBytes(32).toString("base64url"),
    context = JSON.stringify({ desktop: "fixture" });
  f.browser.begin.mockResolvedValue({ context, nonce: committed });
  const { authorization, cookie } = await begin(f.url);
  expect(authorization.searchParams.get("nonce")).toBe(committed);
  await googleAnswers(authorization);
  await callback(f.url, authorization, cookie);
  expect(f.browser.complete.mock.calls[0]!.slice(1, 3)).toEqual([committed, context]);
});

test("a refused sign-in sets no account cookie but still returns to its operation", async () => {
  const f = await setup();
  f.browser.complete.mockResolvedValue({ location: "/_relay/account?signup=fixture" });
  const { authorization, cookie } = await begin(f.url);
  await googleAnswers(authorization);
  const response = await callback(f.url, authorization, cookie);
  expect(response.headers.get("location")).toBe(`${origin}/_relay/account?signup=fixture`);
  expect(response.headers.getSetCookie()).toEqual([expect.stringContaining("Max-Age=0")]);
});

test("a failed sign-in resumes its operation, so its single-use launch isn't wasted", async () => {
  const f = await setup(),
    context = JSON.stringify({ desktop: "fixture" });
  f.browser.begin.mockResolvedValue({ context });
  f.browser.failed.mockImplementation((value) =>
    value === context ? "/_relay/account?failed=google&desktop=fixture" : "/wrong",
  );
  const { authorization, cookie } = await begin(f.url);
  transport.mockResolvedValue(new Response("refused", { status: 400 }));
  expect((await callback(f.url, authorization, cookie)).headers.get("location")).toBe(
    "/_relay/account?failed=google&desktop=fixture",
  );
});

test("the page path only redirects, and the service keeps a restrictive policy", async () => {
  const f = await setup();
  const response = await fetch(`${f.url}/_relay/web?failed=1`, { redirect: "manual" });
  expect(response.headers.get("location")).toBe("/_relay/account");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await fetch(`${f.url}/_relay/web/style.css`)).status).toBe(404);
  expect((await fetch(`${f.url}/_relay/web/start`)).status).toBe(403);
  expect(
    (
      await fetch(`${f.url}/_relay/web/start`, {
        headers: { "sec-fetch-site": "same-origin" },
        redirect: "manual",
      })
    ).status,
  ).toBe(303);
  expect((await fetch(`${f.url}/_relay/web/start`, { method: "DELETE" })).status).toBe(405);
  expect((await fetch(`${f.url}/_relay/web`, { method: "POST" })).status).toBe(405);
  expect((await fetch(`${f.url}/documents`)).status).toBe(404);
  f.service.close();
  expect((await fetch(`${f.url}/_relay/web`)).status).toBe(503);
});

test("foreign form submissions and callbacks without this browser's exact private state cannot exchange Google codes", async () => {
  const f = await setup();
  for (const headers of [
    {},
    { origin: "https://attacker.example.test" },
    { origin: "null" },
  ] as Record<string, string>[]) {
    expect((await fetch(`${f.url}/_relay/web/start`, { method: "POST", headers })).status).toBe(
      403,
    );
  }
  const { authorization, cookie } = await begin(f.url);
  const failed = "/_relay/account?failed=google";
  for (const supplied of [undefined, "other-cookie=value", `${cookie}x`, `${cookie}; ${cookie}`]) {
    expect((await callback(f.url, authorization, supplied)).headers.get("location")).toBe(failed);
  }
  const duplicate = await callback(
    f.url,
    authorization,
    cookie,
    `&state=${authorization.searchParams.get("state")}`,
  );
  expect(duplicate.headers.get("location")).toBe(failed);
  const incorrectCookie = cookie.replace(/=(.)/, (_match, first: string) =>
    first === "X" ? "=Y" : "=X",
  );
  expect(incorrectCookie).not.toBe(cookie);
  const incorrect = await callback(f.url, authorization, incorrectCookie);
  expect(incorrect.headers.get("location")).toBe(failed);
  expect(transport).not.toHaveBeenCalled();
  const start = await fetch(`${f.url}/_relay/web/start`, {
    method: "POST",
    headers: { origin },
    redirect: "manual",
  });
  const setCookie = start.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/^__Host-omnesis-relay-login=/);
  expect(setCookie).not.toContain("Domain=");
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=300"])
    expect(setCookie).toContain(attribute);
});

test("wrong nonces, failed exchanges and foreign continuations end in a generic failure without an open redirect", async () => {
  const f = await setup();
  for (const scenario of ["wrong-nonce", "exchange-failure", "foreign-location"]) {
    const { authorization, cookie } = await begin(f.url);
    transport.mockResolvedValue(
      new Response(
        JSON.stringify({
          id_token: await signed(
            scenario === "wrong-nonce" ? "wrong" : authorization.searchParams.get("nonce")!,
          ),
          token_type: "Bearer",
        }),
        { status: scenario === "exchange-failure" ? 400 : 200 },
      ),
    );
    if (scenario === "foreign-location")
      f.browser.complete.mockResolvedValueOnce({
        cookie: accountCookie,
        location: "https://foreign.example.test",
      });
    const response = await callback(f.url, authorization, cookie);
    expect(response.headers.get("location"), scenario).toBe("/_relay/account?failed=google");
    expect(response.headers.getSetCookie().join()).not.toContain(accountCookie);
    expect(await response.text()).not.toContain(secret);
  }
});

test("bounds outstanding browser state and expires it before any Google exchange", async () => {
  const f = await setup();
  let first!: Awaited<ReturnType<typeof begin>>;
  for (let index = 0; index < 32; index++) {
    const value = await begin(f.url);
    if (index === 0) first = value;
  }
  expect(
    (await fetch(`${f.url}/_relay/web/start`, { method: "POST", headers: { origin } })).status,
  ).toBe(429);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 300_001 });
  expect((await callback(f.url, first.authorization, first.cookie)).headers.get("location")).toBe(
    "/_relay/account?failed=google",
  );
  expect(transport).not.toHaveBeenCalled();
  expect((await begin(f.url)).authorization.origin).toBe("https://accounts.google.com");
});

test("validates the configured HTTPS origin and keeps the client secret server-side", () => {
  const accountBrowserStub = accountBrowser();
  for (const publicOrigin of [
    "http://relay.example.test",
    "https://relay.example.test/path",
    "https://user@relay.example.test",
    "https://127.0.0.1",
  ])
    expect(
      () => new RelayWebLogin({ ...webLogin, publicOrigin, accountBrowser: accountBrowserStub }),
    ).toThrow();
  expect(
    () => new RelayWebLogin({ ...webLogin, clientId: " ", accountBrowser: accountBrowserStub }),
  ).toThrow();
  expect(
    () => new RelayWebLogin({ ...webLogin, clientSecret: " ", accountBrowser: accountBrowserStub }),
  ).toThrow();
});

test("browser Google exchange shares the daemon's concurrent login admission limit", async () => {
  const admission = new LoginAdmission(1, 60),
    f = await setup({}, admission);
  const { authorization, cookie } = await begin(f.url);
  let release!: (response: Response) => void;
  transport.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const pending = callback(f.url, authorization, cookie);
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
  await expect(admission.run(async () => "concurrent", undefined)).rejects.toThrow("capacity");
  release(new Response("refused", { status: 400 }));
  expect((await pending).headers.get("location")).toBe("/_relay/account?failed=google");
});

test("closing the browser service during provider exchange prevents any late callback from signing in", async () => {
  const f = await setup(),
    pending = await begin(f.url);
  let release!: (response: Response) => void;
  transport.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const response = callback(f.url, pending.authorization, pending.cookie);
  await vi.waitFor(() => expect(release).toBeDefined());
  f.service.close();
  release(
    Response.json({
      id_token: await signed(pending.authorization.searchParams.get("nonce")!),
      token_type: "Bearer",
    }),
  );
  expect((await response).headers.get("location")).toBe("/_relay/account?failed=google");
  expect(f.browser.complete).not.toHaveBeenCalled();
});
