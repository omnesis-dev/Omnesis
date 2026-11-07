// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { fixture } from "../test/support.js";
import { localIdentityProvider } from "./identity.js";
import { RelayWebLogin } from "./relay-web-login.js";

const origin = "https://relay.example.test";
const secret = "fictional-relay-backend-secret";
const key = randomBytes(32);
const identity = localIdentityProvider(key, "127.0.0.1");
const transport = vi.fn<typeof fetch>();
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
async function setup() {
  const f = await fixture({ webLogin });
  cleanup.push(() => f.close());
  return f;
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
    {
      headers: cookie === undefined ? {} : { cookie },
      redirect: "manual",
    },
  );
}

test("relay account discovery uses Google PKCE then redirects only to that account's HTTPS gateway without issuing access", async () => {
  const f = await setup();
  f.register();
  const { authorization, cookie } = await begin(f.url);
  expect(authorization.origin).toBe("https://accounts.google.com");
  expect(authorization.searchParams.get("redirect_uri")).toBe(`${origin}/_relay/web/callback`);
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.href).not.toContain(secret);
  transport.mockResolvedValue(
    new Response(
      JSON.stringify({
        id_token: await signed(authorization.searchParams.get("nonce")!),
        token_type: "Bearer",
      }),
    ),
  );
  const response = await callback(f.url, authorization, cookie);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`${f.gatewayUrl}/portal/`);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(response.headers.get("location")).not.toContain("token");
  const [endpoint, init] = transport.mock.calls[0]!;
  expect(endpoint).toBe("https://oauth2.googleapis.com/token");
  expect((init!.body as URLSearchParams).get("client_secret")).toBe(secret);
  expect((init!.body as URLSearchParams).get("code_verifier")).toHaveLength(64);
  const replay = await callback(f.url, authorization, cookie);
  expect(replay.headers.get("location")).toBe("/_relay/web?failed=1");
  expect(transport).toHaveBeenCalledOnce();
});

test("discovery page is self-hosted, secret-free, optional and has a restrictive content security policy", async () => {
  const f = await setup();
  const response = await fetch(`${f.url}/_relay/web`);
  const html = await response.text();
  expect(html).toContain("Find your gateway");
  expect(html).toContain("Google sign-in is optional");
  expect(html).toMatch(
    /<a class="continue"[^>]*><img src="data:image\/png;base64,[A-Za-z0-9+/=]+" width="20" height="20" alt="" aria-hidden="true">Continue with Google<\/a>/,
  );
  expect(response.headers.get("content-security-policy")).toContain("img-src data:");
  expect(html).not.toContain(secret);
  expect(html).not.toContain("<script");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const style = await fetch(`${f.url}/_relay/web/style.css`);
  expect(style.headers.get("content-type")).toContain("text/css");
  expect(await style.text()).toContain("focus-visible");
  const failure = await fetch(`${f.url}/_relay/web?failed=1&error=private-token`);
  expect(await failure.text()).toContain("no gateway is registered");
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
  const disabled = await fixture();
  cleanup.push(() => disabled.close());
  expect((await fetch(`${disabled.url}/_relay/web`)).status).toBe(404);
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
  for (const supplied of [undefined, "other-cookie=value", `${cookie}x`, `${cookie}; ${cookie}`]) {
    expect((await callback(f.url, authorization, supplied)).headers.get("location")).toBe(
      "/_relay/web?failed=1",
    );
  }
  const duplicate = await callback(
    f.url,
    authorization,
    cookie,
    `&state=${authorization.searchParams.get("state")}`,
  );
  expect(duplicate.headers.get("location")).toBe("/_relay/web?failed=1");
  const incorrect = await callback(f.url, authorization, cookie.replace(/=./, "=X"));
  expect(incorrect.headers.get("location")).toBe("/_relay/web?failed=1");
  expect(transport).not.toHaveBeenCalled();
  const start = await fetch(`${f.url}/_relay/web/start`, {
    method: "POST",
    headers: { origin },
    redirect: "manual",
  });
  const setCookie = start.headers.get("set-cookie")!;
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/_relay/web", "Max-Age=300"])
    expect(setCookie).toContain(attribute);
});

test("wrong account, malformed routing URLs and failed Google verification all return a generic failure without an open redirect", async () => {
  const f = await setup();
  f.register();
  const cases = [
    "other-account",
    "http://gateway.example.test",
    "https://user@gateway.example.test",
    "https://gateway.example.test/path",
    "https://gateway.example.test?token=private",
    "javascript:alert(1)",
    "wrong-nonce",
    "exchange-failure",
  ];
  for (const scenario of cases) {
    const { authorization, cookie } = await begin(f.url);
    const nonce = scenario === "wrong-nonce" ? "wrong" : authorization.searchParams.get("nonce")!;
    transport.mockResolvedValue(
      new Response(
        JSON.stringify({
          id_token: await signed(
            nonce,
            scenario === "other-account" ? "fictional-other-account" : "fictional-account",
          ),
          token_type: "Bearer",
        }),
        { status: scenario === "exchange-failure" ? 400 : 200 },
      ),
    );
    const lookup =
      scenario.startsWith("http") || scenario.startsWith("javascript")
        ? vi.spyOn(f.accounts, "gatewayBinding").mockReturnValue({
            gatewayId: "00000000-0000-4000-8000-000000000001",
            publicOrigin: scenario,
            certificate: "fictional-public-certificate",
            identityToken: "fictional-token",
          })
        : undefined;
    const response = await callback(f.url, authorization, cookie);
    expect(response.headers.get("location"), scenario).toBe("/_relay/web?failed=1");
    expect(await response.text()).not.toContain(secret);
    lookup?.mockRestore();
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
    "/_relay/web?failed=1",
  );
  expect(transport).not.toHaveBeenCalled();
  expect((await begin(f.url)).authorization.origin).toBe("https://accounts.google.com");
});

test("validates the configured HTTPS origin and keeps the client secret server-side", () => {
  for (const publicOrigin of [
    "http://relay.example.test",
    "https://relay.example.test/path",
    "https://user@relay.example.test",
    "https://127.0.0.1",
  ]) {
    expect(
      () => new RelayWebLogin({ ...webLogin, publicOrigin, gatewayForAccount: () => undefined }),
    ).toThrow();
  }
  expect(
    () => new RelayWebLogin({ ...webLogin, clientId: " ", gatewayForAccount: () => undefined }),
  ).toThrow();
  expect(
    () => new RelayWebLogin({ ...webLogin, clientSecret: " ", gatewayForAccount: () => undefined }),
  ).toThrow();
});

test("browser Google exchange shares the daemon's concurrent login admission limit", async () => {
  const f = await fixture({ webLogin, loginLimits: { maxConcurrent: 1, maxPerMinute: 60 } });
  cleanup.push(() => f.close());
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
  const concurrent = await fetch(`${f.url}/_relay/v1/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken: "fictional-token" }),
  });
  expect(concurrent.status).toBe(429);
  release(new Response("refused", { status: 400 }));
  expect((await pending).headers.get("location")).toBe("/_relay/web?failed=1");
});
