// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  saveGoogleCredentials,
  googleRoutingTokenSource,
  googleRelaySessionSource,
  exchangeRelayIdentity,
  readBoundedJson,
  readPrivateJson,
} from "./google-credentials.js";
import { accountId, localIdentityProvider } from "./identity.js";
import * as identities from "./identity.js";
import type { GoogleCredentials } from "./google-oauth.js";

vi.mock("node:fs/promises", { spy: true });

const key = randomBytes(32);
const identity = localIdentityProvider(key, "127.0.0.1");
const clientId = "fictional-desktop-client";
let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnesis-google-credentials-"));
  file = join(dir, "private", "credentials.json");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});
async function credentials(
  subject = "fictional-owner",
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
  refreshToken: string | undefined = "fictional-refresh",
) {
  const idToken = await new SignJWT({})
    .setIssuer("omnesis-local-test")
    .setSubject(subject)
    .setAudience("omnesis-cloud-relay")
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);
  return { idToken, refreshToken, identity: { issuer: "omnesis-local-test", subject, expiresAt } };
}

test("writes credentials atomically with private permissions and verifies cached identity locally", async () => {
  const first = await credentials();
  await saveGoogleCredentials(file, clientId, first);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, "private"))).mode & 0o777).toBe(0o700);
  const fetch = vi.fn<typeof globalThis.fetch>();
  const source = googleRoutingTokenSource({ credentialsFile: file, clientId, identity, fetch });
  expect(await source()).toEqual({
    idToken: first.idToken,
    accountId: accountId(first.identity),
    expiresAt: first.identity.expiresAt,
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("refresh routing tolerates a missing nonce but always verifies signature and original account", async () => {
  const original = await credentials("fictional-owner", Math.floor(Date.now() / 1000) + 10);
  await saveGoogleCredentials(file, clientId, original);
  const renewed = await credentials();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_, init) => {
    expect((init!.body as URLSearchParams).get("refresh_token")).toBe("fictional-refresh");
    return Response.json({
      id_token: renewed.idToken,
      token_type: "Bearer",
      refresh_token: "fictional-rotated",
    });
  });
  const source = googleRoutingTokenSource({ credentialsFile: file, clientId, identity, fetch });
  const result = await Promise.all([source(), source(), source()]);
  expect(new Set(result.map((v) => v.idToken))).toEqual(new Set([renewed.idToken]));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    refreshToken: "fictional-rotated",
  });
  expect(await source()).toEqual(result[0]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("expired, invalid, switched account and missing refresh credentials fail closed", async () => {
  const original = await credentials();
  for (const variant of ["expired", "invalid", "switch", "missing-refresh", "wrong-client"]) {
    await saveGoogleCredentials(file, clientId, original);
    const row = JSON.parse(await readFile(file, "utf8"));
    if (variant === "expired") row.idToken = (await credentials("fictional-owner", 1)).idToken;
    else if (variant === "invalid") row.idToken = "invalid";
    else if (variant === "switch") row.idToken = (await credentials("fictional-other")).idToken;
    else if (variant === "wrong-client") row.clientId = "another-client";
    else {
      row.idToken = "invalid";
      delete row.refreshToken;
    }
    await writeFile(file, JSON.stringify(row));
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        id_token: (await credentials("fictional-other")).idToken,
        token_type: "Bearer",
      }),
    );
    const source = googleRoutingTokenSource({ credentialsFile: file, clientId, identity, fetch });
    await expect(source()).rejects.toThrow();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(row);
    if (variant === "wrong-client" || variant === "missing-refresh")
      expect(fetch).not.toHaveBeenCalled();
  }
});

test("failed refresh may be retried after credentials are explicitly replaced", async () => {
  await saveGoogleCredentials(file, clientId, await credentials("fictional-owner", 1));
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response("fictional-sensitive-error", { status: 400 }),
  );
  const source = googleRoutingTokenSource({ credentialsFile: file, clientId, identity, fetch });
  await expect(source()).rejects.not.toThrow("fictional-sensitive-error");
  const replacement = await credentials();
  await saveGoogleCredentials(file, clientId, replacement);
  expect((await source()).idToken).toBe(replacement.idToken);
});

test("a fresh login without offline consent persists no refresh token", async () => {
  const first: GoogleCredentials = await credentials();
  first.refreshToken = undefined;
  await saveGoogleCredentials(file, clientId, first);
  expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("refreshToken");
});

test("credential files are bounded and validated before contacting Google", async () => {
  await writeFile(join(dir, "large.json"), "x".repeat(65_537));
  await expect(
    googleRoutingTokenSource({ credentialsFile: join(dir, "large.json"), clientId, identity })(),
  ).rejects.toThrow("too large");
  await writeFile(join(dir, "invalid.json"), "{}");
  await expect(
    googleRoutingTokenSource({ credentialsFile: join(dir, "invalid.json"), clientId, identity })(),
  ).rejects.toThrow();
  await writeFile(join(dir, "invalid.json"), '{"fictional-sensitive-refresh-token');
  await expect(readPrivateJson(join(dir, "invalid.json"))).rejects.not.toThrow(
    "fictional-sensitive-refresh-token",
  );
});

test("default verifier and private installed-client secret are used for authenticated routing refresh", async () => {
  vi.spyOn(identities, "googleIdentityProvider").mockReturnValue(identity);
  const secretFile = join(dir, "client.json");
  await writeFile(
    secretFile,
    JSON.stringify({
      installed: { client_id: clientId, client_secret: "fictional-private-secret" },
    }),
  );
  for (const explicit of [false, true]) {
    await saveGoogleCredentials(file, clientId, await credentials("fictional-owner", 1));
    const fresh = await credentials();
    const transport = vi.fn<typeof fetch>(async (_, init) => {
      expect((init!.body as URLSearchParams).get("client_secret")).toBe(
        explicit ? "explicit-private-secret" : "fictional-private-secret",
      );
      return Response.json({ id_token: fresh.idToken, token_type: "Bearer" });
    });
    const source = googleRoutingTokenSource({
      credentialsFile: file,
      clientId,
      clientSecretFile: secretFile,
      ...(explicit ? { clientSecret: "explicit-private-secret" } : {}),
      fetch: transport,
    });
    expect((await source()).idToken).toBe(fresh.idToken);
    expect(identities.googleIdentityProvider).toHaveBeenCalledWith(clientId);
  }
});

test("relay exchange checks account, lifetime and response bounds and saves only routing credentials", async () => {
  const first = await credentials();
  const owner = accountId(first.identity);
  const session = {
    token: "fictional-relay-token",
    accountId: owner,
    expiresAt: Math.floor(Date.now() / 1000) + 1800,
  };
  const sessionFile = join(dir, "session.json");
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://relay.example.test/_relay/v1/login");
    expect(JSON.parse(init!.body as string)).toEqual({ idToken: first.idToken });
    expect(init!.redirect).toBe("error");
    return Response.json(session);
  });
  expect(
    await exchangeRelayIdentity({
      relayUrl: "https://relay.example.test",
      idToken: first.idToken,
      expectedAccountId: owner,
      sessionFile,
      fetch: transport,
    }),
  ).toEqual(session);
  expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(sessionFile, "utf8"))).toEqual(session);
  for (const value of [
    { ...session, accountId: "a".repeat(64) },
    { ...session, expiresAt: 1 },
    {},
  ]) {
    await expect(
      exchangeRelayIdentity({
        relayUrl: "https://relay.example.test",
        idToken: first.idToken,
        expectedAccountId: owner,
        sessionFile,
        fetch: async () => Response.json(value),
      }),
    ).rejects.toThrow();
  }
  await expect(
    exchangeRelayIdentity({
      relayUrl: "https://relay.example.test",
      idToken: first.idToken,
      expectedAccountId: owner,
      sessionFile,
      fetch: async () => new Response("sensitive", { status: 403 }),
    }),
  ).rejects.not.toThrow("sensitive");
  await expect(readBoundedJson(new Response("x".repeat(65_537)))).rejects.toThrow("too large");
  await expect(readBoundedJson(new Response(null))).rejects.toThrow();
});

test.each(["before login", "before publishing"])(
  "relay exchange preserves saved credentials when cancelled %s",
  async (stage) => {
    const first = await credentials();
    const owner = accountId(first.identity);
    const sessionFile = join(dir, "session.json");
    const saved = JSON.stringify({ token: "saved-test-token" });
    await writeFile(sessionFile, saved);
    const abort = new AbortController();
    const cancel = () => abort.abort(new Error("Relay exchange cancelled"));
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init!.signal!.aborted).toBe(false);
      return Response.json({
        token: "new-test-token",
        accountId: owner,
        expiresAt: Math.floor(Date.now() / 1000) + 1800,
      });
    });
    if (stage === "before login") cancel();
    else
      vi.spyOn(files, "mkdir").mockImplementationOnce(async () => {
        cancel();
        return undefined;
      });
    await expect(
      exchangeRelayIdentity({
        relayUrl: "https://relay.example.test",
        idToken: first.idToken,
        expectedAccountId: owner,
        sessionFile,
        fetch: transport,
        signal: abort.signal,
      }),
    ).rejects.toThrow("Relay exchange cancelled");
    expect(transport).toHaveBeenCalledTimes(stage === "before login" ? 0 : 1);
    expect(await readFile(sessionFile, "utf8")).toBe(saved);
  },
);

test("long-running gateway session refresh is single-flight and retries transient failures", async () => {
  const first = await credentials();
  await saveGoogleCredentials(file, clientId, first);
  const sessionFile = join(dir, "routing.json");
  const owner = accountId(first.identity);
  const transport = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("Temporary relay outage"))
    .mockImplementation(async () =>
      Response.json({
        token: `relay-token-${transport.mock.calls.length}`,
        accountId: owner,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
    );
  const source = googleRelaySessionSource({
    credentialsFile: file,
    clientId,
    identity,
    relayUrl: "https://relay.example.test",
    sessionFile,
    fetch: transport,
  });
  await expect(source()).rejects.toThrow("Temporary relay outage");
  expect(await Promise.all([source(), source()])).toEqual(["relay-token-2", "relay-token-2"]);
  expect(await source()).toBe("relay-token-2");
  expect(transport).toHaveBeenCalledTimes(2);
  vi.useFakeTimers({ now: Date.now() + 31_000 });
  expect(await source()).toBe("relay-token-3");
  expect(transport).toHaveBeenCalledTimes(3);
});
