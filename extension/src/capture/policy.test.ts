// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_CAPTURE_RULES } from "@omnesis/provider-web/capture-policy";
import { MemoryStore } from "../push/test-fakes.js";
import {
  CAPTURE_POLICY_KEY,
  CAPTURE_POLICY_TTL_MS,
  clearCachedPolicy,
  policyIsStale,
  readCachedPolicy,
  writeCachedPolicy,
} from "./policy.js";

const policy = {
  updatedAt: "",
  pause: null,
  excludedDomains: [],
  ownedDomains: [],
  rules: DEFAULT_WEB_CAPTURE_RULES,
  removedPages: [],
  removedPagesTruncated: false,
};

describe("cached capture policy", () => {
  it("round-trips through the durable store and clears to nothing", async () => {
    const store = new MemoryStore();
    expect(await readCachedPolicy(store)).toBeNull();
    await writeCachedPolicy(store, policy, 1_000);
    expect(await readCachedPolicy(store)).toEqual({ policy, fetchedAt: 1_000 });
    await clearCachedPolicy(store);
    expect(await readCachedPolicy(store)).toBeNull();
  });

  it("treats a damaged or malformed copy as absent", async () => {
    const store = new MemoryStore();
    await store.set(CAPTURE_POLICY_KEY, "{not json");
    expect(await readCachedPolicy(store)).toBeNull();
    await store.set(CAPTURE_POLICY_KEY, JSON.stringify({ policy: { nope: 1 }, fetchedAt: 1 }));
    expect(await readCachedPolicy(store)).toBeNull();
    await store.set(CAPTURE_POLICY_KEY, JSON.stringify({ policy, fetchedAt: "yesterday" }));
    expect(await readCachedPolicy(store)).toBeNull();
  });

  it("is stale once the TTL has passed, and when the clock went backwards", () => {
    const cached = { policy, fetchedAt: 10_000 };
    expect(policyIsStale(cached, 10_000 + CAPTURE_POLICY_TTL_MS - 1)).toBe(false);
    expect(policyIsStale(cached, 10_000 + CAPTURE_POLICY_TTL_MS)).toBe(true);
    expect(policyIsStale(cached, 9_000)).toBe(true);
  });
});
