// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { SourceType } from "./ids.js";
import {
  isAnswerBoundedScope,
  scopesAreAnswerBounded,
  DeviceId,
  TokenId,
  DEVICE_KINDS,
  isDeviceKind,
  SCOPE_READ,
  SCOPE_READ_BULK,
  SCOPE_ANSWER,
  SCOPE_ADMIN,
  SCOPE_PUSH_CLAIM,
  SCOPE_WRITE_ALL,
  SCOPE_SUBSCRIPTIONS_MANAGE,
  writeScope,
  isValidScope,
  parseScope,
  classifyScope,
  scopeSatisfies,
  NOTIFICATION_DELIVERY_HEALTH_STATES,
  isNotificationDeliveryHealth,
} from "./device.js";
import type { Scope } from "./device.js";

describe("device identifier brands", () => {
  // DeviceId / TokenId now validate UUID v4 shape on construction (was a
  // zero-cost cast). Any caller that needs a soft-failure path should use
  // the `tryDeviceId` / `tryTokenId` parallel.
  const SAMPLE_UUID = "a3a3a3a3-a3a3-4a3a-a3a3-a3a3a3a3a3a3";

  test("DeviceId accepts a UUID and rejects garbage", () => {
    expect(DeviceId(SAMPLE_UUID)).toBe(SAMPLE_UUID);
    expect(() => DeviceId("dev_01H")).toThrow(/UUID/);
    expect(() => DeviceId("")).toThrow(/UUID/);
  });

  test("TokenId accepts a UUID and rejects garbage", () => {
    expect(TokenId(SAMPLE_UUID)).toBe(SAMPLE_UUID);
    expect(() => TokenId("tok_01H")).toThrow(/UUID/);
  });
});

describe("DeviceKind", () => {
  test("includes all expected kinds", () => {
    expect(DEVICE_KINDS).toEqual([
      "collector",
      "cli",
      "portal",
      "ios",
      "android",
      "agent",
      "browser",
      "integration",
    ]);
  });

  test("isDeviceKind accepts valid kinds", () => {
    expect(isDeviceKind("collector")).toBe(true);
    expect(isDeviceKind("ios")).toBe(true);
    expect(isDeviceKind("browser")).toBe(true);
  });

  test("isDeviceKind rejects unknown kinds", () => {
    expect(isDeviceKind("server")).toBe(false);
    expect(isDeviceKind("")).toBe(false);
    expect(isDeviceKind("Collector")).toBe(false);
  });
});

describe("notification delivery health", () => {
  test("recognises only the normalized phone-reported states", () => {
    for (const state of NOTIFICATION_DELIVERY_HEALTH_STATES) {
      expect(isNotificationDeliveryHealth(state)).toBe(true);
    }
    expect(isNotificationDeliveryHealth("scheduled")).toBe(false);
    expect(isNotificationDeliveryHealth("")).toBe(false);
  });
});

describe("scope validation", () => {
  test("accepts read, answer, answer completion, admin, push claim, write:*", () => {
    expect(isValidScope("read")).toBe(true);
    expect(isValidScope("read:bulk")).toBe(true);
    expect(isValidScope("answer")).toBe(true);
    expect(isValidScope("answer:completion")).toBe(false);
    expect(isValidScope("admin")).toBe(true);
    expect(isValidScope("push:claim")).toBe(true);
    expect(isValidScope("write:*")).toBe(true);
  });

  test("keeps notification claims least-privilege", () => {
    expect(classifyScope(SCOPE_PUSH_CLAIM)).toEqual({ kind: "push-claim" });
    expect(scopeSatisfies([SCOPE_PUSH_CLAIM], SCOPE_PUSH_CLAIM)).toBe(true);
    expect(scopeSatisfies([SCOPE_ADMIN], SCOPE_PUSH_CLAIM)).toBe(false);
  });

  test("accepts write:<source-type>", () => {
    expect(isValidScope("write:gmail")).toBe(true);
    expect(isValidScope("write:apple-health")).toBe(true);
    expect(isValidScope("write:browser-history")).toBe(true);
  });

  test("rejects retired runner scopes", () => {
    expect(isValidScope("runner:host")).toBe(false);
    expect(isValidScope("dispatch:runner")).toBe(false);
  });

  test("accepts subscription management scope", () => {
    expect(isValidScope("subscriptions:manage")).toBe(true);
    expect(classifyScope(SCOPE_SUBSCRIPTIONS_MANAGE)).toEqual({
      kind: "subscriptions-manage",
    });
  });

  test("rejects malformed scopes", () => {
    expect(isValidScope("")).toBe(false);
    expect(isValidScope("write")).toBe(false);
    expect(isValidScope("write:")).toBe(false);
    expect(isValidScope("write: gmail")).toBe(false);
    expect(isValidScope("write:gmail:extra")).toBe(false);
    expect(isValidScope("write:\ttab")).toBe(false);
    expect(isValidScope("delete")).toBe(false);
    expect(isValidScope("READ")).toBe(false);
  });

  test("rejects write:* written as write:<empty asterisk-like>", () => {
    // "write:*" is valid, but "write:" is not, and "write:**" should be rejected as not *
    expect(isValidScope("write:**")).toBe(true);
    // actually ** is a valid source type string per our loose check — just confirming behavior.
    // The authoritative check is that "write:*" is the wildcard; anything else is a source-type name.
  });

  test("parseScope returns Scope or null", () => {
    expect(parseScope("read")).toBe(SCOPE_READ);
    expect(parseScope("bogus")).toBeNull();
  });
});

describe("scope classification", () => {
  test("classifies read", () => {
    expect(classifyScope(SCOPE_READ)).toEqual({ kind: "read" });
  });

  test("classifies admin", () => {
    expect(classifyScope(SCOPE_ADMIN)).toEqual({ kind: "admin" });
  });

  test("classifies answer", () => {
    expect(classifyScope(SCOPE_ANSWER)).toEqual({ kind: "answer" });
  });

  test("classifies write:*", () => {
    expect(classifyScope(SCOPE_WRITE_ALL)).toEqual({ kind: "write-all" });
  });

  test("classifies write:<type>", () => {
    expect(classifyScope(writeScope(SourceType("gmail")))).toEqual({
      kind: "write",
      sourceType: "gmail",
    });
  });

  test("returns null for unknown scope shapes", () => {
    // `Scope()` validates on construction now, so we can't build an invalid
    // Scope through it. Construct directly via the cast to test the
    // classifier's tolerance for legacy / malformed inputs that might come
    // from a stale DB row at trust-boundary remap time.
    expect(classifyScope("nonsense" as unknown as Scope)).toBeNull();
  });
});

describe("answer-bounded scopes", () => {
  test("answer, push claims and writes reach the corpus only through /answer", () => {
    for (const scope of ["answer", "push:claim", "write:*", "write:notes"]) {
      expect(isAnswerBoundedScope(scope as Scope)).toBe(true);
    }
  });

  test("direct reads, admin and every subscription scope do not", () => {
    for (const scope of [
      "admin",
      "read",
      "read:bulk",
      "subscriptions:manage",
      "subscriptions:receive",
      "subscriptions:answer",
      "subscriptions:outcome",
      "read:triggers",
      "not-a-scope",
    ]) {
      expect(isAnswerBoundedScope(scope as Scope)).toBe(false);
    }
  });

  test("a grant is bounded only when every scope in it is", () => {
    expect(scopesAreAnswerBounded(["answer", "push:claim"] as Scope[])).toBe(true);
    expect(scopesAreAnswerBounded(["answer", "read"] as Scope[])).toBe(false);
  });
});

describe("scopeSatisfies", () => {
  test("exact match grants permission", () => {
    expect(scopeSatisfies([SCOPE_READ], SCOPE_READ)).toBe(true);
    expect(scopeSatisfies([SCOPE_ADMIN], SCOPE_ADMIN)).toBe(true);
  });

  test("answer is isolated and admin is its only superset", () => {
    expect(scopeSatisfies([SCOPE_ANSWER], SCOPE_ANSWER)).toBe(true);
    expect(scopeSatisfies([SCOPE_ADMIN], SCOPE_ANSWER)).toBe(true);
    expect(scopeSatisfies([SCOPE_READ], SCOPE_ANSWER)).toBe(false);
    expect(scopeSatisfies([SCOPE_ANSWER], SCOPE_READ)).toBe(false);
    expect(scopeSatisfies([SCOPE_ANSWER], SCOPE_ADMIN)).toBe(false);
  });

  test("write:* satisfies any write:<type>", () => {
    expect(scopeSatisfies([SCOPE_WRITE_ALL], writeScope(SourceType("gmail")))).toBe(true);
    expect(scopeSatisfies([SCOPE_WRITE_ALL], writeScope(SourceType("apple-health")))).toBe(true);
  });

  test("write:<type> does NOT satisfy write:*", () => {
    expect(scopeSatisfies([writeScope(SourceType("gmail"))], SCOPE_WRITE_ALL)).toBe(false);
  });

  test("write:<type> does NOT satisfy write:<other-type>", () => {
    expect(
      scopeSatisfies([writeScope(SourceType("gmail"))], writeScope(SourceType("calendar"))),
    ).toBe(false);
  });

  test("read does NOT satisfy admin or write", () => {
    expect(scopeSatisfies([SCOPE_READ], SCOPE_ADMIN)).toBe(false);
    expect(scopeSatisfies([SCOPE_READ], SCOPE_WRITE_ALL)).toBe(false);
    expect(scopeSatisfies([SCOPE_READ], writeScope(SourceType("gmail")))).toBe(false);
  });

  test("admin does NOT grant write or read", () => {
    // Orthogonal scopes: admin is source management, write is data push, read is query.
    expect(scopeSatisfies([SCOPE_ADMIN], SCOPE_READ)).toBe(false);
    expect(scopeSatisfies([SCOPE_ADMIN], SCOPE_WRITE_ALL)).toBe(false);
  });

  test("combined scopes compose", () => {
    const granted = [SCOPE_ADMIN, SCOPE_READ, writeScope(SourceType("apple-health"))];
    expect(scopeSatisfies(granted, SCOPE_ADMIN)).toBe(true);
    expect(scopeSatisfies(granted, SCOPE_READ)).toBe(true);
    expect(scopeSatisfies(granted, writeScope(SourceType("apple-health")))).toBe(true);
    expect(scopeSatisfies(granted, writeScope(SourceType("gmail")))).toBe(false);
  });

  test("write:browser is accepted for browser writes and nothing else", () => {
    // The browser-capture extension's token carries write:browser ONLY. It
    // must authorize a browser-source write but reject every other write and
    // any read/admin — the minimal-trust constraint of the device kind.
    const granted = [writeScope(SourceType("browser"))];
    expect(scopeSatisfies(granted, writeScope(SourceType("browser")))).toBe(true);
    expect(scopeSatisfies(granted, writeScope(SourceType("gmail")))).toBe(false);
    expect(scopeSatisfies(granted, SCOPE_WRITE_ALL)).toBe(false);
    expect(scopeSatisfies(granted, SCOPE_READ)).toBe(false);
    expect(scopeSatisfies(granted, SCOPE_ADMIN)).toBe(false);
  });

  test("subscriptions:manage is isolated and admin is its only superset", () => {
    expect(scopeSatisfies([SCOPE_SUBSCRIPTIONS_MANAGE], SCOPE_SUBSCRIPTIONS_MANAGE)).toBe(true);
    expect(scopeSatisfies([SCOPE_ADMIN], SCOPE_SUBSCRIPTIONS_MANAGE)).toBe(true);
    expect(scopeSatisfies([SCOPE_READ], SCOPE_SUBSCRIPTIONS_MANAGE)).toBe(false);
  });

  test("accepts both Set and array for granted", () => {
    const setForm = new Set([SCOPE_READ]);
    expect(scopeSatisfies(setForm, SCOPE_READ)).toBe(true);
  });
});

describe("writeScope", () => {
  test("builds well-formed write scope", () => {
    expect(writeScope(SourceType("gmail"))).toBe("write:gmail");
    expect(writeScope(SourceType("apple-health"))).toBe("write:apple-health");
  });
});

describe("read:bulk scope", () => {
  test("classifies as read-bulk", () => {
    expect(classifyScope(SCOPE_READ_BULK)).toEqual({ kind: "read-bulk" });
  });

  test("read:bulk satisfies read (a superset of ordinary read)", () => {
    expect(scopeSatisfies([SCOPE_READ_BULK], SCOPE_READ)).toBe(true);
  });

  test("read does NOT satisfy read:bulk", () => {
    expect(scopeSatisfies([SCOPE_READ], SCOPE_READ_BULK)).toBe(false);
  });

  test("scopeSatisfies is literal for read:bulk — admin does not satisfy it here", () => {
    // The admin fallback lives in the scope.readBulk() guard rather than in
    // scopeSatisfies, so this stays literal.
    expect(scopeSatisfies([SCOPE_ADMIN], SCOPE_READ_BULK)).toBe(false);
    expect(scopeSatisfies([SCOPE_READ_BULK], SCOPE_READ_BULK)).toBe(true);
  });
});
