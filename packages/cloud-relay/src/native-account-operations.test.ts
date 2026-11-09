// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { NativeAccountOperations } from "./native-account-operations.js";

function intent() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    input: {
      nonce: randomBytes(32).toString("base64url"),
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      kind: "android",
    },
  };
}
test("native account operations bind their opaque ticket, PKCE and exact private device challenge", async () => {
  const operations = new NativeAccountOperations(),
    value = intent(),
    started = operations.start(value.input);
  expect(started.googleNonce).not.toBe(value.input.nonce);
  expect(operations.binding(started.operationId, started.ticket)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(() => operations.binding(started.operationId, "x".repeat(43))).toThrow("unavailable");
  expect(() => operations.binding(started.operationId, "bad")).toThrow("unavailable");
  expect(() => operations.binding(randomUUID(), started.ticket)).toThrow("unavailable");
  await expect(
    operations.complete(started.operationId, started.ticket, "bad", async () => "wrong"),
  ).rejects.toThrow("verification refused");
  await expect(
    operations.complete(started.operationId, started.ticket, "x".repeat(43), async () => "wrong"),
  ).rejects.toThrow("verification refused");
  expect(
    await operations.complete(
      started.operationId,
      started.ticket,
      value.verifier,
      async (context) => {
        expect(context.intent).toEqual(value.input);
        expect(context.googleNonce).toBe(started.googleNonce);
        context.current();
        return "verified";
      },
    ),
  ).toBe("verified");
  await expect(
    operations.complete(
      started.operationId,
      started.ticket,
      value.verifier,
      async () => "replayed",
    ),
  ).rejects.toThrow("unavailable");
});

test("cancellation, expiry, failed verification and shutdown cannot return late credentials or reuse an operation", async () => {
  let now = 1_000;
  for (const mode of ["cancel", "expire", "close", "failure"] as const) {
    const operations = new NativeAccountOperations({ maxPending: 1, ttlMs: 100 }, () => now),
      value = intent(),
      started = operations.start(value.input);
    let release!: () => void;
    const result = operations.complete(
      started.operationId,
      started.ticket,
      value.verifier,
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (mode === "failure") throw new Error("fixture failure");
        return "late result";
      },
    );
    expect(() => operations.binding(started.operationId, started.ticket)).toThrow("in progress");
    await expect(
      operations.complete(
        started.operationId,
        started.ticket,
        value.verifier,
        async () => "duplicate",
      ),
    ).rejects.toThrow("in progress");
    if (mode === "cancel") operations.cancel(started.operationId, started.ticket);
    if (mode === "expire") now += 101;
    if (mode === "close") operations.close();
    release();
    await expect(result).rejects.toThrow();
    expect(() => operations.binding(started.operationId, started.ticket)).toThrow();
  }
});

test("pending budgets and deadlines are bounded and closed services cannot create or resume sign-ins", () => {
  let now = 1_000;
  const operations = new NativeAccountOperations({ maxPending: 1, ttlMs: 100 }, () => now),
    value = intent();
  expect(() => operations.start({ ...value.input, nonce: "invalid" })).toThrow("Invalid");
  operations.start(value.input);
  expect(() => operations.start(value.input)).toThrow("Too many");
  now += 101;
  expect(operations.start(value.input).expiresAt).toBe(now + 100);
  operations.close();
  expect(() => operations.start(value.input)).toThrow("unavailable");
  for (const limits of [
    { maxPending: 0, ttlMs: 100 },
    { maxPending: 1, ttlMs: 0 },
    { maxPending: 1, ttlMs: 300001 },
  ])
    expect(() => new NativeAccountOperations(limits)).toThrow("limits");
});
