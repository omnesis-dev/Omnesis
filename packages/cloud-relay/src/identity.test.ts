// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  accountId,
  googleIdentityProvider,
  localIdentityProvider,
  RelaySessions,
} from "./identity.js";
import { RelayAccounts } from "./accounts.js";
import { LoginAdmission } from "./admission.js";

const secret = randomBytes(32);
const identity = {
  issuer: "https://identity.example.test",
  subject: "fictional-account",
  expiresAt: Math.floor(Date.now() / 1000) + 7200,
};
afterEach(() => vi.useRealTimers());

describe("provider identity", () => {
  test("account IDs bind issuer and immutable subject, without storing emails", () => {
    expect(accountId(identity)).toMatch(/^[a-f0-9]{64}$/);
    expect(accountId({ ...identity, expiresAt: 1 })).toBe(accountId(identity));
    expect(accountId({ ...identity, issuer: "other" })).not.toBe(accountId(identity));
    expect(accountId({ ...identity, subject: "other" })).not.toBe(accountId(identity));
  });

  test("Google validates signature, audience, issuer, expiry and required claims", async () => {
    const instant = Math.floor(Date.now() / 1000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant * 1000);
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] });
    const verifier = googleIdentityProvider("fictional-client", keys);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "accounts.google.com",
      aud: "fictional-client",
      sub: "fictional-subject",
      exp: now + 3600,
      iat: now,
    };
    const sign = (payload: Record<string, unknown>) =>
      new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);
    expect(await verifier.verify(await sign(claims))).toEqual({
      issuer: "https://accounts.google.com",
      subject: "fictional-subject",
      expiresAt: now + 3600,
    });
    expect(
      await verifier.verify(await sign({ ...claims, iss: "https://accounts.google.com" })),
    ).toEqual(await verifier.verify(await sign(claims)));
    for (const patch of [
      { aud: "different-client" },
      { iss: "https://attacker.example.test" },
      { exp: now - 1 },
      { sub: "" },
      { sub: "x".repeat(256) },
      { exp: now + 0.5 },
      { iat: now - 3601 },
      { iat: now + 1 },
      { azp: "untrusted-client" },
      { azp: 4 },
    ]) {
      await expect(verifier.verify(await sign({ ...claims, ...patch }))).rejects.toThrow();
    }
    for (const claim of ["sub", "exp", "iat", "iss"]) {
      const missing: Record<string, unknown> = { ...claims };
      delete missing[claim];
      await expect(verifier.verify(await sign(missing))).rejects.toThrow();
    }
    const multi = googleIdentityProvider(["fictional-client", "fictional-mobile"], keys);
    expect(
      await multi.verify(
        await sign({
          ...claims,
          aud: ["fictional-client", "fictional-mobile"],
          azp: "fictional-mobile",
          nonce: "private-request",
        }),
        "private-request",
      ),
    ).toMatchObject({ subject: claims.sub });
    await expect(
      multi.verify(await sign({ ...claims, nonce: "different-request" }), "private-request"),
    ).rejects.toThrow("nonce");
    for (const ids of [[], [""], Array.from({ length: 17 }, () => "client")])
      expect(() => googleIdentityProvider(ids)).toThrow("client ID");
    const hybrid = googleIdentityProvider("fictional-web", keys, {
      authorizedParties: ["fictional-web", "fictional-android"],
    });
    const androidToken = await sign({
      ...claims,
      aud: "fictional-web",
      azp: "fictional-android",
      nonce: "hybrid-request",
    });
    expect(await hybrid.verify(androidToken, "hybrid-request")).toMatchObject({
      subject: claims.sub,
    });
    await expect(
      googleIdentityProvider("fictional-web", keys).verify(androidToken, "hybrid-request"),
    ).rejects.toThrow("authorized party");
    await expect(
      hybrid.verify(await sign({ ...claims, aud: "fictional-android", azp: "fictional-android" })),
    ).rejects.toThrow();
    await expect(
      googleIdentityProvider("fictional-gateway", keys).verify(
        await sign({
          ...claims,
          aud: "fictional-gateway",
          azp: "fictional-android",
          nonce: "key-attestation",
        }),
        "key-attestation",
      ),
    ).rejects.toThrow("authorized party");
    for (const parties of [[], [" "], Array.from({ length: 17 }, () => "client")])
      expect(() =>
        googleIdentityProvider("fictional-web", keys, { authorizedParties: parties }),
      ).toThrow("authorized party");
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(other.privateKey);
    await expect(verifier.verify(forged)).rejects.toThrow();
    await expect(verifier.verify("garbage")).rejects.toThrow();
    expect(() => googleIdentityProvider(" ")).toThrow("client ID");
    // Creating the default remote verifier performs no network request.
    expect(googleIdentityProvider("fictional-client")).toHaveProperty("verify");
  });

  test("mock identity is signed, audience-bound, expiring and loopback-only", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "fictional-local-account" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("omnesis-local-test")
      .setAudience("omnesis-cloud-relay")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(secret);
    for (const bind of ["127.0.0.1", "::1"])
      expect(await localIdentityProvider(secret, bind).verify(token)).toEqual({
        issuer: "omnesis-local-test",
        subject: "fictional-local-account",
        expiresAt: now + 60,
      });
    for (const bind of ["0.0.0.0", "localhost", "::", "192.0.2.1"])
      expect(() => localIdentityProvider(secret, bind)).toThrow("loopback");
    expect(() => localIdentityProvider(new Uint8Array(31), "127.0.0.1")).toThrow("32 bytes");
    await expect(
      localIdentityProvider(randomBytes(32), "127.0.0.1").verify(token),
    ).rejects.toThrow();
    vi.useFakeTimers();
    vi.setSystemTime((now + 61) * 1000);
    await expect(localIdentityProvider(secret, "127.0.0.1").verify(token)).rejects.toThrow();
  });
});

describe("relay sessions", () => {
  test("short-lived sessions are distinct, account-bound and cannot extend identity expiry", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sessions = new RelaySessions(secret);
    const session = await sessions.issue(identity);
    expect(session.expiresAt).toBeLessThanOrEqual(now + 3601);
    expect(await sessions.verify(session.token)).toEqual({
      accountId: accountId(identity),
      expiresAt: session.expiresAt,
    });
    expect((await sessions.issue({ ...identity, expiresAt: now + 10 })).expiresAt).toBe(now + 10);
    await expect(new RelaySessions(randomBytes(32)).verify(session.token)).rejects.toThrow();
    await expect(sessions.verify("invalid")).rejects.toThrow();
    await expect(sessions.issue({ ...identity, expiresAt: now })).rejects.toThrow("expired");
    vi.useFakeTimers();
    vi.setSystemTime((session.expiresAt + 1) * 1000);
    await expect(sessions.verify(session.token)).rejects.toThrow();
  });

  test("rejects weak keys, invalid lifetime, wrong-purpose and invalid account sessions", async () => {
    expect(() => new RelaySessions(new Uint8Array(31))).toThrow("32 bytes");
    for (const ttl of [0, -1, 3601, 1.5, NaN])
      expect(() => new RelaySessions(secret, ttl)).toThrow("lifetime");
    for (const claims of [
      { purpose: "gateway-grant", sub: accountId(identity) },
      { purpose: "relay-routing-v1", sub: "bad" },
    ]) {
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("omnesis-cloud-relay")
        .setAudience("omnesis-cloud-relay")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(secret);
      await expect(new RelaySessions(secret).verify(token)).rejects.toThrow();
    }
  });
});

describe("durable account bindings", () => {
  test("one gateway per account survives restart and cannot be claimed across accounts", () => {
    const dir = mkdtempSync(join(tmpdir(), "cloud-accounts-"));
    let accounts = new RelayAccounts(join(dir, "accounts.sqlite"), 2);
    try {
      const gateway = randomUUID();
      accounts.registerAccount("first");
      const databasePath = join(dir, "accounts.sqlite");
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
      expect(statSync(databasePath + "-wal").mode & 0o777).toBe(0o600);
      expect(statSync(databasePath + "-shm").mode & 0o777).toBe(0o600);
      chmodSync(databasePath + "-wal", 0o644);
      chmodSync(databasePath + "-shm", 0o644);
      const reopened = new RelayAccounts(databasePath);
      expect(statSync(databasePath + "-wal").mode & 0o777).toBe(0o600);
      expect(statSync(databasePath + "-shm").mode & 0o777).toBe(0o600);
      reopened.close();
      accounts.registerAccount("first");
      accounts.registerAccount("second");
      expect(() => accounts.registerAccount("third")).toThrow("capacity");
      expect(accounts.bindGateway("first", gateway)).toBe(true);
      expect(accounts.bindGateway("first", gateway)).toBe(true);
      expect(accounts.bindGateway("first", randomUUID())).toBe(false);
      expect(accounts.bindGateway("second", gateway)).toBe(false);
      expect(accounts.bindGateway("missing", randomUUID())).toBe(false);
      expect(() => accounts.bindGateway("second", "bad")).toThrow();
      accounts.close();
      accounts = new RelayAccounts(join(dir, "accounts.sqlite"));
      expect(accounts.bindGateway("first", gateway)).toBe(true);
      expect(accounts.bindGateway("first", randomUUID())).toBe(false);
      expect(accounts.bindGateway("second", randomUUID())).toBe(true);
    } finally {
      accounts.close();
      rmSync(dir, { recursive: true, force: true });
    }
    for (const cap of [0, -1, 1.5, NaN])
      expect(() => new RelayAccounts(":memory:", cap)).toThrow("limit");
  });
});

describe("login admission", () => {
  test("bounds concurrent work, releases on failure, and caps attempts per minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const admission = new LoginAdmission(1, 2);
    let release!: () => void;
    const pending = admission.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(admission.run(async () => "extra")).rejects.toThrow("capacity");
    release();
    await pending;
    await expect(
      admission.run(async () => {
        throw new Error("provider down");
      }),
    ).rejects.toThrow("provider down");
    await expect(admission.run(async () => "extra")).rejects.toThrow("capacity");
    vi.setSystemTime(60_000);
    expect(await admission.run(async () => "ok")).toBe("ok");
    expect(await new LoginAdmission().run(async () => "default")).toBe("default");
    for (const cap of [0, -1, 1.5, NaN]) {
      expect(() => new LoginAdmission(cap, 1)).toThrow("positive");
      expect(() => new LoginAdmission(1, cap)).toThrow("positive");
    }
  });
});
