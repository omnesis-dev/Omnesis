// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import {
  GooglePairingRequests,
  googlePairingNonce,
  googlePairingVerificationCode,
  type GooglePairingRequest,
} from "./google-pairing.js";
import { localIdentityProvider, accountId } from "./identity.js";

const key = randomBytes(32);
const identity = localIdentityProvider(key, "127.0.0.1");
const owner = {
  issuer: "omnesis-local-test",
  subject: "fictional-owner",
  expiresAt: 4_000_000_000,
};
const createPairing = vi.fn(async () => ({
  pairingCode: "SYNTHETIC-CODE",
  expiresAt: Date.now() + 60_000,
}));
const make = (extra: Partial<ConstructorParameters<typeof GooglePairingRequests>[0]> = {}) =>
  new GooglePairingRequests({
    identity,
    ownerAccountId: accountId(owner),
    createPairing,
    gatewayFingerprint: () => "a".repeat(64),
    ...extra,
  });
async function request(subject = owner.subject): Promise<GooglePairingRequest> {
  const value = {
    requestId: randomUUID(),
    kind: "ios" as const,
    name: "Fictional phone",
    secret: randomBytes(32).toString("hex"),
  };
  const identityToken = await new SignJWT({ nonce: googlePairingNonce(value) })
    .setIssuer(owner.issuer)
    .setSubject(subject)
    .setAudience("omnesis-cloud-relay")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);
  return { ...value, identityToken };
}
afterEach(() => {
  vi.useRealTimers();
  createPairing.mockClear();
});

test("Google login only creates an approval request, never a device token or grant", async () => {
  const service = make();
  const value = await request();
  const pending = await service.start(value);
  expect(pending.status).toBe("pending");
  expect(pending.pairingCode).toBeUndefined();
  expect(pending.verificationCode).toBe(googlePairingVerificationCode(value, "a".repeat(64)));
  expect(pending.verificationCode).not.toBe(googlePairingVerificationCode(value, "b".repeat(64)));
  expect(createPairing).not.toHaveBeenCalled();
  expect(service.poll(value.requestId, value.secret)).toEqual(pending);
  const visible = service.list();
  expect(visible[0]).toMatchObject({
    requestId: value.requestId,
    name: value.name,
    kind: value.kind,
    verificationCode: pending.verificationCode,
  });
  const serialized = JSON.stringify(visible);
  expect(serialized).not.toContain(value.secret);
  expect(serialized).not.toContain(value.identityToken);
  await service.decide(value.requestId, true);
  const approved = service.poll(value.requestId, value.secret);
  expect(approved.status).toBe("approved");
  expect(approved.pairingCode).toBe("SYNTHETIC-CODE");
  expect(createPairing).toHaveBeenCalledExactlyOnceWith({
    kind: value.kind,
    name: value.name,
    expiresAt: pending.expiresAt,
  });
  expect(approved.expiresAt).toBeLessThanOrEqual(pending.expiresAt);
  await expect(service.decide(value.requestId, true)).rejects.toMatchObject({ status: 409 });
});

test("stolen routing identity tokens cannot change the request or reveal its approved credential", async () => {
  const service = make();
  const value = await request();
  await expect(
    service.start({ ...value, secret: randomBytes(32).toString("hex") }),
  ).rejects.toThrow("nonce");
  await expect(service.start({ ...value, kind: "collector" })).rejects.toThrow("nonce");
  await service.start(value);
  await service.decide(value.requestId, true);
  expect(() => service.poll(value.requestId, "wrong")).toThrow("not found");
  await expect(service.start({ ...value, name: "Another device" })).rejects.toMatchObject({
    status: 409,
  });
  expect(await service.start(value)).toEqual(service.poll(value.requestId, value.secret));
});

test("a different Google subject or invalid identity cannot create an owner-approved request", async () => {
  const service = make();
  await expect(service.start(await request("fictional-other-person"))).rejects.toMatchObject({
    status: 403,
  });
  await expect(service.start({ ...(await request()), identityToken: "invalid" })).rejects.toThrow();
  expect(service.list()).toEqual([]);
  expect(createPairing).not.toHaveBeenCalled();
  await expect(service.start({ ...(await request()), scopes: ["admin"] })).rejects.toThrow();
});

test("approval is atomic and a rejection cannot race an in-flight credential issuance", async () => {
  let release!: () => void;
  const issue = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { pairingCode: "ONE-CODE", expiresAt: Date.now() + 600_000 };
  });
  const service = make({ createPairing: issue });
  const value = await request();
  await service.start(value);
  const a = service.decide(value.requestId, true);
  const b = service.decide(value.requestId, true);
  expect(service.poll(value.requestId, value.secret).status).toBe("pending");
  await expect(service.decide(value.requestId, false)).rejects.toMatchObject({ status: 409 });
  await Promise.resolve();
  release();
  await Promise.all([a, b]);
  expect(issue).toHaveBeenCalledTimes(1);
  expect(service.poll(value.requestId, value.secret).pairingCode).toBe("ONE-CODE");
});

test("denial and expiry release no credentials; failed issuance can be retried explicitly", async () => {
  const service = make({ ttlMs: 1000 });
  const value = await request();
  await service.start(value);
  await service.decide(value.requestId, false);
  expect(service.poll(value.requestId, value.secret).status).toBe("denied");
  await expect(service.decide(value.requestId, false)).rejects.toMatchObject({ status: 409 });
  vi.useFakeTimers({ now: Date.now() + 1001 });
  expect(service.list()).toEqual([]);
  expect(() => service.poll(value.requestId, value.secret)).toThrow("not found");
  await expect(service.decide(value.requestId, true)).rejects.toMatchObject({ status: 404 });
  vi.useRealTimers();
  const issue = vi
    .fn()
    .mockRejectedValueOnce(new Error("Writer unavailable"))
    .mockResolvedValueOnce({ pairingCode: "RETRY", expiresAt: Date.now() + 1000 });
  const retry = make({ createPairing: issue });
  const second = await request();
  await retry.start(second);
  await expect(retry.decide(second.requestId, true)).rejects.toThrow("Writer unavailable");
  expect(retry.poll(second.requestId, second.secret).status).toBe("pending");
  await retry.decide(second.requestId, true);
  expect(retry.poll(second.requestId, second.secret).pairingCode).toBe("RETRY");
});

test("reserves bounded verification capacity before asynchronous identity verification", async () => {
  let release!: () => void;
  const service = make({
    maxPending: 1,
    identity: {
      verify: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return owner;
      },
    },
  });
  const first = await request();
  const pending = service.start(first);
  expect(service.list()).toEqual([]);
  expect(() => service.poll(first.requestId, first.secret)).toThrow("not found");
  await expect(service.decide(first.requestId, true)).rejects.toMatchObject({ status: 404 });
  await expect(service.start(await request())).rejects.toMatchObject({ status: 429 });
  release();
  await pending;
});

test("expiration while identity or grant creation is pending cannot resurrect a request", async () => {
  for (const phase of ["identity", "grant"]) {
    let release!: () => void;
    const wait = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const service = make({
      ttlMs: 1000,
      identity:
        phase === "identity"
          ? {
              verify: async () => {
                await wait();
                return owner;
              },
            }
          : identity,
      createPairing: async () => {
        await wait();
        return { pairingCode: "EXPIRED", expiresAt: Date.now() + 1000 };
      },
    });
    const value = await request();
    const pending =
      phase === "identity"
        ? service.start(value)
        : (await service.start(value), service.decide(value.requestId, true));
    await Promise.resolve();
    vi.useFakeTimers({ now: Date.now() + 1001 });
    expect(service.list()).toEqual([]);
    release();
    await expect(pending).rejects.toMatchObject({ status: 404 });
    expect(() => service.poll(value.requestId, value.secret)).toThrow();
    vi.useRealTimers();
  }
});

test("validates owner identity and admission limits", () => {
  expect(() => make({ ownerAccountId: "invalid" })).toThrow();
  expect(() => make({ gatewayFingerprint: () => "invalid" })).toThrow();
  for (const limit of [0, -1, NaN, 2_147_483_648]) {
    expect(() => make({ ttlMs: limit })).toThrow();
    expect(() => make({ maxPending: limit })).toThrow();
  }
});

test("certificate rotation invalidates pending approvals rather than authorizing a different gateway key", async () => {
  let fingerprint = "a".repeat(64);
  const service = make({ gatewayFingerprint: () => fingerprint });
  const value = await request();
  await service.start(value);
  fingerprint = "b".repeat(64);
  await expect(service.decide(value.requestId, true)).rejects.toMatchObject({ status: 409 });
  expect(createPairing).not.toHaveBeenCalled();
  expect(service.poll(value.requestId, value.secret).pairingCode).toBeUndefined();
});
