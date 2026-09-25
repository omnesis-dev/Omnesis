// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  digestSecret,
  RelayStore,
  RELAY_RATE_LIMIT_DAILY,
  RELAY_RATE_LIMIT_HOURLY,
  RELAY_RATE_WINDOW_HOUR_MS,
} from "./store.js";
import type { RelayTarget } from "./types.js";

const target: RelayTarget = {
  platform: "ios",
  token: "ab".repeat(32),
  appId: "dev.omnesis.ios",
  environment: "production",
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function addCredential(
  store: RelayStore,
  suffix: string,
  now = 1_000,
  credentialTarget: RelayTarget = target,
): { credential: string; hash: Buffer } {
  const nonce = `nonce-${suffix}`;
  const credential = `omnrelay_v1_${suffix.padEnd(43, "x")}`;
  const hash = digestSecret(credential);
  store.createChallenge({
    id: `challenge-${suffix}`,
    target: credentialTarget,
    nonceHash: digestSecret(nonce),
    createdAt: now,
    expiresAt: now + 10_000,
  });
  expect(
    store.verifyChallengeAndCreateCredential({
      challengeId: `challenge-${suffix}`,
      nonceHash: digestSecret(nonce),
      credentialHash: hash,
      now,
    }),
  ).toEqual(credentialTarget);
  return { credential, hash };
}

describe("RelayStore challenge and credential semantics", () => {
  it("recognizes only an active credential for the exact carrier target", () => {
    const store = new RelayStore();
    expect(store.hasActiveCredentialForTarget(target)).toBe(false);
    const { hash } = addCredential(store, "target");
    expect(store.hasActiveCredentialForTarget(target)).toBe(true);
    expect(store.hasActiveCredentialForTarget({ ...target, token: "other" })).toBe(false);
    expect(store.hasActiveCredentialForTarget({ ...target, appId: "example.other" })).toBe(false);
    expect(store.hasActiveCredentialForTarget({ ...target, environment: "sandbox" })).toBe(false);
    store.revokeCredential(hash, 2_000);
    expect(store.hasActiveCredentialForTarget(target)).toBe(false);
    store.close();
  });

  it("atomically bounds all live challenge rows and recovers by pruning expiry", () => {
    const store = new RelayStore();
    const input = (id: string, createdAt: number, expiresAt: number) => ({
      id,
      target,
      nonceHash: digestSecret(id),
      createdAt,
      expiresAt,
    });
    expect(store.tryCreateChallenge(input("one", 0, 10), 1)).toBe(true);
    expect(
      store.verifyChallengeAndCreateCredential({
        challengeId: "one",
        nonceHash: digestSecret("one"),
        credentialHash: digestSecret("credential-one"),
        now: 1,
      }),
    ).toEqual(target);
    expect(store.tryCreateChallenge(input("two", 1, 11), 1)).toBe(false);
    expect(store.tryCreateChallenge(input("three", 10, 20), 1)).toBe(true);
    expect(store.db.prepare("SELECT id FROM relay_challenges").all()).toEqual([{ id: "three" }]);
    store.close();
  });

  it("shares the pending ceiling across store handles", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-relay-capacity-"));
    dirs.push(dir);
    const path = join(dir, "relay.db");
    const first = new RelayStore(path);
    const second = new RelayStore(path);
    const challenge = (id: string) => ({
      id,
      target,
      nonceHash: digestSecret(id),
      createdAt: 0,
      expiresAt: 100,
    });
    expect(first.tryCreateChallenge(challenge("first"), 1)).toBe(true);
    expect(second.tryCreateChallenge(challenge("second"), 1)).toBe(false);
    first.close();
    second.close();
  });

  it("reports only aggregate active credentials and unanswered challenges", () => {
    const store = new RelayStore();
    store.createChallenge({
      id: "unanswered",
      target,
      nonceHash: digestSecret("nonce"),
      createdAt: 100,
      expiresAt: 500,
    });
    expect(store.challengePlatform("unanswered")).toBe("ios");
    expect(store.challengePlatform("unknown")).toBeNull();
    addCredential(store, "active", 100);
    expect(store.operationalSnapshot()).toEqual({
      activeCredentials: { ios: 1, android: 0 },
    });
    expect(store.prune(600).unansweredChallenges).toEqual({ ios: 1, android: 0 });
    store.close();
  });

  it("consumes a valid challenge exactly once and scopes the credential to its target", () => {
    const store = new RelayStore();
    const nonceHash = digestSecret("correct-nonce");
    const credentialHash = digestSecret("credential");
    store.createChallenge({
      id: "challenge-1",
      target,
      nonceHash,
      createdAt: 100,
      expiresAt: 500,
    });

    expect(
      store.verifyChallengeAndCreateCredential({
        challengeId: "challenge-1",
        nonceHash,
        credentialHash,
        now: 200,
      }),
    ).toEqual(target);
    expect(
      store.verifyChallengeAndCreateCredential({
        challengeId: "challenge-1",
        nonceHash,
        credentialHash: digestSecret("other"),
        now: 201,
      }),
    ).toBeNull();
    expect(store.lookupCredential(credentialHash)).toEqual(target);
    store.close();
  });

  it("rejects a forged nonce and an expired challenge without consuming it early", () => {
    const store = new RelayStore();
    store.createChallenge({
      id: "challenge-2",
      target,
      nonceHash: digestSecret("correct"),
      createdAt: 100,
      expiresAt: 200,
    });
    expect(
      store.verifyChallengeAndCreateCredential({
        challengeId: "challenge-2",
        nonceHash: digestSecret("forged"),
        credentialHash: digestSecret("credential"),
        now: 150,
      }),
    ).toBeNull();
    expect(
      store.verifyChallengeAndCreateCredential({
        challengeId: "challenge-2",
        nonceHash: digestSecret("correct"),
        credentialHash: digestSecret("credential"),
        now: 200,
      }),
    ).toBeNull();
    store.close();
  });

  it("rotates atomically only after successful proof and only for the exact target", () => {
    const store = new RelayStore();
    const old = addCredential(store, "old", 100);
    const siblingTarget: RelayTarget = { ...target, token: "cd".repeat(32) };
    const siblingNonce = digestSecret("sibling-nonce");
    const siblingHash = digestSecret("sibling-credential");
    store.createChallenge({
      id: "sibling-challenge",
      target: siblingTarget,
      nonceHash: siblingNonce,
      createdAt: 100,
      expiresAt: 1_000,
    });
    expect(
      store.verifyChallengeAndCreateCredential({
        challengeId: "sibling-challenge",
        nonceHash: siblingNonce,
        credentialHash: siblingHash,
        now: 150,
      }),
    ).toEqual(siblingTarget);

    const rotationNonce = digestSecret("rotation-nonce");
    const rotatedHash = digestSecret("rotated-credential");
    store.createChallenge({
      id: "rotation-challenge",
      target,
      nonceHash: rotationNonce,
      createdAt: 200,
      expiresAt: 1_000,
    });
    expect(
      store.verifyChallengeAndCreateCredential({
        challengeId: "rotation-challenge",
        nonceHash: digestSecret("forged"),
        credentialHash: rotatedHash,
        now: 250,
      }),
    ).toBeNull();
    expect(store.lookupCredential(old.hash)).toEqual(target);

    expect(
      store.verifyChallengeAndCreateCredential({
        challengeId: "rotation-challenge",
        nonceHash: rotationNonce,
        credentialHash: rotatedHash,
        now: 300,
      }),
    ).toEqual(target);
    expect(store.lookupCredential(old.hash)).toBeNull();
    expect(store.lookupCredential(rotatedHash)).toEqual(target);
    expect(store.lookupCredential(siblingHash)).toEqual(siblingTarget);
    const retired = store.db
      .prepare("SELECT token, app_id, revoked_at FROM relay_credentials WHERE credential_hash = ?")
      .get(old.hash) as { token: string; app_id: string; revoked_at: number };
    expect(retired).toEqual({ token: "", app_id: "", revoked_at: 300 });
    store.close();
  });

  it("stores only credential digests, persists them, and revokes one credential independently", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-relay-store-"));
    dirs.push(dir);
    const path = join(dir, "relay.db");
    const first = new RelayStore(path);
    const a = addCredential(first, "a");
    const siblingTarget: RelayTarget = { ...target, token: "cd".repeat(32) };
    const b = addCredential(first, "b", 1_000, siblingTarget);
    const raw = first.db
      .prepare("SELECT CAST(credential_hash AS TEXT) AS value FROM relay_credentials")
      .all() as Array<{ value: string }>;
    expect(raw.map((row) => row.value)).not.toContain(a.credential);
    first.close();

    const reopened = new RelayStore(path);
    expect(reopened.lookupCredential(a.hash)).toEqual(target);
    expect(reopened.lookupCredential(b.hash)).toEqual(siblingTarget);
    expect(reopened.revokeCredential(a.hash, 2_000)).toBe(true);
    expect(reopened.lookupCredential(a.hash)).toBeNull();
    expect(reopened.lookupCredential(b.hash)).toEqual(siblingTarget);
    expect(reopened.revokeCredential(a.hash, 2_001)).toBe(false);
    reopened.close();
  });
});

describe("RelayStore rate limiting", () => {
  it("allows 30 per hour, rejects the next, and recovers when the rolling hour passes", () => {
    const store = new RelayStore();
    const { hash } = addCredential(store, "hour", 0);
    for (let i = 0; i < RELAY_RATE_LIMIT_HOURLY; i += 1) {
      expect(store.consumeRateLimit(hash, 0).allowed).toBe(true);
    }
    const denied = store.consumeRateLimit(hash, 0);
    expect(denied).toMatchObject({ allowed: false, limit: "hour" });
    expect(denied.retryAfterMs).toBe(RELAY_RATE_WINDOW_HOUR_MS);
    expect(store.consumeRateLimit(hash, RELAY_RATE_WINDOW_HOUR_MS).allowed).toBe(true);
    store.close();
  });

  it("enforces 300 per rolling day while keeping credentials in independent buckets", () => {
    const store = new RelayStore();
    const a = addCredential(store, "daily-a", 0).hash;
    const b = addCredential(store, "daily-b", 0).hash;
    let now = 0;
    for (let batch = 0; batch < RELAY_RATE_LIMIT_DAILY / RELAY_RATE_LIMIT_HOURLY; batch += 1) {
      for (let i = 0; i < RELAY_RATE_LIMIT_HOURLY; i += 1) {
        expect(store.consumeRateLimit(a, now).allowed).toBe(true);
      }
      now += 2 * RELAY_RATE_WINDOW_HOUR_MS;
    }
    expect(store.consumeRateLimit(a, now)).toMatchObject({ allowed: false, limit: "day" });
    expect(store.consumeRateLimit(b, now).allowed).toBe(true);
    store.close();
  });
});
