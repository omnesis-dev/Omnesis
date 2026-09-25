// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the portal's browser-native storage policy.
import { describe, expect, it } from "vitest";
import {
  AGENT_RETURN_STATE_KEY,
  AGENT_RETURN_WINDOW_MS,
  conversationAgentTarget,
  freshAgentTarget,
  isAgentReturnStateRecent,
  readAgentReturnState,
  resolveAgentReturnTarget,
  writeAgentReturnState,
} from "./agent-return-policy.js";

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
}

describe("portal agent return policy", () => {
  const now = 10_000_000;

  it("restores the exact conversation inside the one-hour window", () => {
    expect(
      resolveAgentReturnTarget({
        directConversationId: null,
        saved: {
          lastVisibleAt: now - AGENT_RETURN_WINDOW_MS + 1,
          target: conversationAgentTarget("conv-recent"),
        },
        now,
      }),
    ).toEqual(conversationAgentTarget("conv-recent"));
  });

  it("preserves a recent fresh-empty destination", () => {
    expect(
      resolveAgentReturnTarget({
        directConversationId: null,
        saved: { lastVisibleAt: now - 1, target: freshAgentTarget() },
        now,
      }),
    ).toEqual(freshAgentTarget());
  });

  it("opens fresh at the one-hour boundary and for future timestamps", () => {
    for (const lastVisibleAt of [now - AGENT_RETURN_WINDOW_MS, now + 1]) {
      expect(
        resolveAgentReturnTarget({
          directConversationId: null,
          saved: { lastVisibleAt, target: conversationAgentTarget("conv-stale") },
          now,
        }),
      ).toEqual(freshAgentTarget());
      expect(isAgentReturnStateRecent({ lastVisibleAt }, now)).toBe(false);
    }
  });

  it("lets a direct conversation URL win over stale or corrupt storage", () => {
    expect(
      resolveAgentReturnTarget({
        directConversationId: "conv-deep-link",
        saved: { lastVisibleAt: 0, target: freshAgentTarget() },
        now,
      }),
    ).toEqual(conversationAgentTarget("conv-deep-link"));
  });

  it("round-trips conversation and fresh targets through storage", () => {
    const storage = memoryStorage();
    writeAgentReturnState(conversationAgentTarget("conv-one"), now, storage);
    expect(readAgentReturnState(storage)).toEqual({
      lastVisibleAt: now,
      target: conversationAgentTarget("conv-one"),
    });
    writeAgentReturnState(freshAgentTarget(), now + 1, storage);
    expect(readAgentReturnState(storage)).toEqual({
      lastVisibleAt: now + 1,
      target: freshAgentTarget(),
    });
  });

  it("keeps each open tab's exact target while retaining a relaunch fallback", () => {
    const durable = memoryStorage();
    const tabA = memoryStorage();
    const tabB = memoryStorage();
    writeAgentReturnState(conversationAgentTarget("conv-a"), now, tabA, durable);
    writeAgentReturnState(conversationAgentTarget("conv-b"), now + 1, tabB, durable);

    expect(readAgentReturnState(tabA, durable)?.target).toEqual(
      conversationAgentTarget("conv-a"),
    );
    expect(readAgentReturnState(tabB, durable)?.target).toEqual(
      conversationAgentTarget("conv-b"),
    );
    expect(readAgentReturnState(memoryStorage(), durable)?.target).toEqual(
      conversationAgentTarget("conv-b"),
    );
  });

  it("treats malformed storage and storage failures as absent", () => {
    const malformed = memoryStorage({ [AGENT_RETURN_STATE_KEY]: "{not-json" });
    expect(readAgentReturnState(malformed)).toBeNull();
    expect(
      readAgentReturnState({ getItem: () => { throw new Error("blocked"); } }),
    ).toBeNull();
    expect(() =>
      writeAgentReturnState(freshAgentTarget(), now, {
        setItem: () => { throw new Error("quota"); },
      }),
    ).not.toThrow();
  });
});
