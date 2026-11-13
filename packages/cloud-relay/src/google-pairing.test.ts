// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import {
  GooglePairingRequests,
  googlePairingNonce,
  type GooglePairingRequest,
} from "./google-pairing.js";
import { pairingCodeCommitment, pairingComparisonCode } from "./device-enrollment.js";
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
/** What a device does: ask for a challenge, then answer it with the request. */
const start = (service: GooglePairingRequests, value: object) =>
  service.start({ ...value, challenge: service.issueChallenge().challenge });
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
  const pending = await start(service, value);
  expect(pending.status).toBe("pending");
  expect(pending.pairingCode).toBeUndefined();
  expect(pending.verificationCode).toBe(
    pairingComparisonCode({
      ...value,
      gatewayFingerprint: "a".repeat(64),
      codeNonce: pending.codeNonce,
    }),
  );
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
    start(service, { ...value, secret: randomBytes(32).toString("hex") }),
  ).rejects.toThrow("nonce");
  await expect(start(service, { ...value, kind: "collector" })).rejects.toThrow("nonce");
  await start(service, value);
  await service.decide(value.requestId, true);
  expect(() => service.poll(value.requestId, "wrong")).toThrow("not found");
  await expect(start(service, { ...value, name: "Another device" })).rejects.toMatchObject({
    status: 409,
  });
  expect(await start(service, value)).toEqual(service.poll(value.requestId, value.secret));
});

test("a different Google subject or invalid identity cannot create an owner-approved request", async () => {
  const service = make();
  await expect(start(service, await request("fictional-other-person"))).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    start(service, { ...(await request()), identityToken: "invalid" }),
  ).rejects.toThrow();
  expect(service.list()).toEqual([]);
  expect(createPairing).not.toHaveBeenCalled();
  await expect(start(service, { ...(await request()), scopes: ["admin"] })).rejects.toThrow();
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
  await start(service, value);
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
  await start(service, value);
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
  await start(retry, second);
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
  const pending = start(service, first);
  expect(service.list()).toEqual([]);
  expect(() => service.poll(first.requestId, first.secret)).toThrow("not found");
  await expect(service.decide(first.requestId, true)).rejects.toMatchObject({ status: 404 });
  await expect(start(service, await request())).rejects.toMatchObject({ status: 429 });
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
        ? start(service, value)
        : (await start(service, value), service.decide(value.requestId, true));
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
  await start(service, value);
  fingerprint = "b".repeat(64);
  await expect(service.decide(value.requestId, true)).rejects.toMatchObject({ status: 409 });
  expect(createPairing).not.toHaveBeenCalled();
  expect(service.poll(value.requestId, value.secret).pairingCode).toBeUndefined();
});

test("only verified new pending enrollments emit one notification hint and hints never grant access", async () => {
  const onPending = vi.fn();
  const service = make({ onPending });
  await expect(start(service, await request("another-owner"))).rejects.toThrow();
  expect(onPending).not.toHaveBeenCalled();
  const value = await request();
  const pending = await start(service, value);
  await start(service, value);
  expect(onPending).toHaveBeenCalledExactlyOnceWith({
    requestId: value.requestId,
    expiresAt: pending.expiresAt,
  });
  expect(createPairing).not.toHaveBeenCalled();
  onPending.mockImplementationOnce(() => {
    throw new Error("Synthetic notification failure");
  });
  const second = await request();
  expect(await start(service, second)).toMatchObject({ status: "pending" });
  expect(service.poll(second.requestId, second.secret)).toMatchObject({ status: "pending" });
});

test("asynchronous notification failures do not escape or invalidate the pending request", async () => {
  const service = make({
    onPending: () => Promise.reject(new Error("Synthetic asynchronous notification failure")),
  });
  const value = await request();
  expect(await start(service, value)).toMatchObject({ status: "pending" });
  await Promise.resolve();
  expect(service.poll(value.requestId, value.secret)).toMatchObject({ status: "pending" });
  expect(createPairing).not.toHaveBeenCalled();
});

test("the gateway commits to its code nonce in the challenge and reveals it only to the request that answers it", async () => {
  const service = make();
  const { challenge } = service.issueChallenge();
  const value = await request();
  const pending = await service.start({ ...value, challenge });
  expect(pairingCodeCommitment(pending.codeNonce)).toBe(challenge);
  expect(service.poll(value.requestId, value.secret).codeNonce).toBe(pending.codeNonce);
  // What an approving device is shown never carries the nonce or the secret.
  expect(JSON.stringify(service.list())).not.toContain(pending.codeNonce);
  // A retry of the same request is answered with the same nonce and code, not a second draw.
  expect(await service.start({ ...value, challenge })).toEqual(pending);
  expect(await start(service, value)).toEqual(pending);
});

test("a challenge is good for one request: none, unknown, spent and expired ones are refused", async () => {
  const service = make();
  await expect(service.start(await request())).rejects.toMatchObject({ status: 409 });
  await expect(
    service.start({ ...(await request()), challenge: pairingCodeCommitment("A".repeat(43)) }),
  ).rejects.toMatchObject({ status: 409 });
  const { challenge } = service.issueChallenge();
  await service.start({ ...(await request()), challenge });
  await expect(service.start({ ...(await request()), challenge })).rejects.toMatchObject({
    status: 409,
  });
  const late = service.issueChallenge();
  vi.useFakeTimers({ now: late.expiresAt });
  await expect(
    service.start({ ...(await request()), challenge: late.challenge }),
  ).rejects.toMatchObject({ status: 409 });
  expect(service.list()).toHaveLength(1);
});

test("a refused request spends its challenge and learns nothing about the nonce", async () => {
  const service = make();
  const { challenge } = service.issueChallenge();
  const refused = await service
    .start({ ...(await request("fictional-other-person")), challenge })
    .catch((error: unknown) => error);
  expect(refused).toMatchObject({ status: 403 });
  expect(JSON.stringify(refused, Object.getOwnPropertyNames(refused))).not.toMatch(/codeNonce/);
  // The same challenge cannot be tried again with different request values.
  await expect(service.start({ ...(await request()), challenge })).rejects.toMatchObject({
    status: 409,
  });
});

test("whoever sends a request cannot choose its code: the same request draws an unrelated one each time", async () => {
  const value = await request();
  const codes = new Set<string>();
  const nonces = new Set<string>();
  for (let attempt = 0; attempt < 24; attempt++) {
    const pending = await start(make(), value);
    codes.add(pending.verificationCode);
    nonces.add(pending.codeNonce);
    expect(pending.verificationCode).toMatch(/^[0-9]{3} [0-9]{3}$/);
  }
  expect(nonces.size).toBe(24);
  // 24 draws from a million: a repeat would mean the request, not the gateway, decides the code.
  expect(codes.size).toBeGreaterThanOrEqual(23);
});

test("only a few requests wait for approval at once, so a forger gets that many codes and no more", async () => {
  const service = make();
  const waiting = [];
  for (let index = 0; index < 8; index++) {
    const value = await request();
    waiting.push(value);
    await start(service, value);
  }
  const extra = await request();
  const { challenge } = service.issueChallenge();
  const refused = await service.start({ ...extra, challenge }).catch((error: unknown) => error);
  expect(refused).toMatchObject({ status: 429 });
  expect(service.list()).toHaveLength(8);
  expect(() => service.poll(extra.requestId, extra.secret)).toThrow("not found");
  // The refusal spent the challenge too: there is no free second look.
  await expect(service.start({ ...extra, challenge })).rejects.toMatchObject({ status: 409 });
  // A request in the middle of being approved still counts.
  let release!: () => void;
  createPairing.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { pairingCode: "SYNTHETIC-CODE", expiresAt: Date.now() + 60_000 };
  });
  const approving = service.decide(waiting[0]!.requestId, true);
  await expect(start(service, extra)).rejects.toMatchObject({ status: 429 });
  release();
  await approving;
  // Only a decision by the person frees a place.
  expect((await start(service, extra)).status).toBe("pending");
  await expect(start(service, await request())).rejects.toMatchObject({ status: 429 });
  await service.decide(waiting[1]!.requestId, false);
  expect((await start(service, await request())).status).toBe("pending");
  expect(make({ maxAwaitingApproval: 1 })).toBeInstanceOf(GooglePairingRequests);
  expect(() => make({ maxAwaitingApproval: 0 })).toThrow();
});

test("a request the gateway starts for a returning browser draws its own nonce and needs no challenge", async () => {
  const service = make();
  const value = await request();
  const pending = await service.startForBrowser(value);
  expect(pending.status).toBe("pending");
  expect(pending.verificationCode).toBe(
    pairingComparisonCode({
      ...value,
      gatewayFingerprint: "a".repeat(64),
      codeNonce: pending.codeNonce,
    }),
  );
  const other = await service.startForBrowser(await request());
  expect(other.codeNonce).not.toBe(pending.codeNonce);
});
