// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import { DeviceId, SourceType } from "@omnesis/types";
import { AuthFlowRegistry } from "./auth-flows.js";

// Fake but well-formed UUID — DeviceId() now validates UUID-v4 shape, so
// the previous "d" / "dev-1" placeholders no longer pass the constructor.
const TEST_DEVICE_ID = "11111111-1111-4111-8111-111111111111";

describe("AuthFlowRegistry", () => {
  test("an overdue asynchronous update expires rather than reviving the flow", () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const reg = new AuthFlowRegistry({ ttlMs: 1000, onExpire: cancel });
      const flow = reg.start({
        sourceType: SourceType("example"),
        deviceId: DeviceId(TEST_DEVICE_ID),
      });
      vi.advanceTimersByTime(1001);
      expect(reg.update(flow.id, { state: "awaiting-user" })).toBeNull();
      expect(cancel).toHaveBeenCalledExactlyOnceWith(flow);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(["completed", "error"] as const)(
    "%s is terminal even when late collector events arrive",
    (state) => {
      const reg = new AuthFlowRegistry();
      const flow = reg.start({
        sourceType: SourceType("example"),
        deviceId: DeviceId(TEST_DEVICE_ID),
      });
      reg.update(flow.id, { state });
      const subscriber = vi.fn();
      reg.subscribe(flow.id, subscriber);
      reg.ingestEvent(flow.id, { type: "qr", data: "late-payload" });
      reg.ingestEvent(flow.id, { type: "complete", ok: true, accountId: "late-account" });
      expect(reg.get(flow.id)?.state).toBe(state);
      expect(reg.get(flow.id)?.resolvedAccountId).toBeUndefined();
      expect(subscriber).not.toHaveBeenCalled();
    },
  );
  test("collector activity extends an active flow beyond its original lifetime", () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const reg = new AuthFlowRegistry({ ttlMs: 1000, onExpire: cancel });
      const flow = reg.start({
        sourceType: SourceType("example"),
        deviceId: DeviceId(TEST_DEVICE_ID),
      });
      for (let step = 0; step < 4; step++) {
        vi.advanceTimersByTime(900);
        reg.ingestEvent(flow.id, { type: "info", message: "Next consent step" });
        expect(reg.cleanup()).toBe(0);
        expect(reg.get(flow.id)).not.toBeNull();
      }
      reg.ingestEvent(flow.id, { type: "complete", ok: true, accountId: "local" });
      vi.advanceTimersByTime(1001);
      expect(reg.cleanup()).toBe(1);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("idle expiry cancels the live subprocess once; reads do not prolong it", () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const reg = new AuthFlowRegistry({ ttlMs: 1000, onExpire: cancel });
      const flow = reg.start({
        sourceType: SourceType("example"),
        deviceId: DeviceId(TEST_DEVICE_ID),
      });
      vi.advanceTimersByTime(900);
      expect(reg.get(flow.id)).not.toBeNull();
      vi.advanceTimersByTime(101);
      expect(reg.get(flow.id)).toBeNull();
      expect(reg.cleanup()).toBe(0);
      expect(cancel).toHaveBeenCalledExactlyOnceWith(flow);
      expect(reg.ingestEvent(flow.id, { type: "complete", ok: true })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("error replay retains the upstream retry delay", () => {
    const reg = new AuthFlowRegistry();
    const flow = reg.start({
      sourceType: SourceType("example"),
      deviceId: DeviceId(TEST_DEVICE_ID),
    });
    reg.ingestEvent(flow.id, { type: "error", error: "Try later", retryAfterMs: 1200 });
    expect(reg.get(flow.id)?.errorDetail?.retryAfterMs).toBe(1200);
  });

  test("start returns a flow with UUID id and starting state", () => {
    const reg = new AuthFlowRegistry();
    const flow = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    expect(flow.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(flow.state).toBe("starting");
    expect(flow.deviceId).toBe(TEST_DEVICE_ID);
  });

  test("get returns the stored flow", () => {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    expect(reg.get(f.id)?.id).toBe(f.id);
  });

  test("update patches and bumps updatedAt", async () => {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("notion"), deviceId: DeviceId(TEST_DEVICE_ID) });
    const originalUpdated = f.updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    const updated = reg.update(f.id, {
      state: "awaiting-user",
      authUrl: "https://example.com/auth",
    });
    expect(updated?.state).toBe("awaiting-user");
    expect(updated?.authUrl).toBe("https://example.com/auth");
    expect(updated!.updatedAt).toBeGreaterThan(originalUpdated);
  });

  test("remove deletes the flow", () => {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    reg.remove(f.id);
    expect(reg.get(f.id)).toBeNull();
  });

  test("cleanup removes expired flows", async () => {
    const reg = new AuthFlowRegistry({ ttlMs: 5 });
    reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.cleanup()).toBe(2);
    expect(reg.list()).toHaveLength(0);
  });

  test("get returns null for expired flow", async () => {
    const reg = new AuthFlowRegistry({ ttlMs: 5 });
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.get(f.id)).toBeNull();
  });

  test("subscribe receives ingested events and updates state", () => {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    const events: unknown[] = [];
    const unsubscribe = reg.subscribe(f.id, (e) => events.push(e));

    reg.ingestEvent(f.id, { type: "url", url: "https://oauth.example/auth?x=1" });
    reg.ingestEvent(f.id, { type: "complete", ok: true, accountId: "user@example.com" });

    expect(events).toHaveLength(2);
    expect(reg.get(f.id)?.state).toBe("completed");
    expect(reg.get(f.id)?.resolvedAccountId).toBe("user@example.com");
    expect(reg.get(f.id)?.authUrl).toBe("https://oauth.example/auth?x=1");

    unsubscribe();
    reg.ingestEvent(f.id, { type: "url", url: "https://second" });
    expect(events).toHaveLength(2); // unsubscribed
  });

  test("ingestEvent on missing flow returns null without throwing", () => {
    const reg = new AuthFlowRegistry();
    expect(reg.ingestEvent("missing", { type: "url", url: "x" })).toBeNull();
  });

  test("subscriber error does not break other subscribers", () => {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("notion"), deviceId: DeviceId(TEST_DEVICE_ID) });
    let other = 0;
    reg.subscribe(f.id, () => {
      throw new Error("boom");
    });
    reg.subscribe(f.id, () => {
      other++;
    });
    reg.ingestEvent(f.id, { type: "qr", data: "QRPAYLOAD" });
    expect(other).toBe(1);
    expect(reg.get(f.id)?.qrData).toBe("QRPAYLOAD");
  });

  test("complete with ok=false moves flow to error", () => {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("notion"), deviceId: DeviceId(TEST_DEVICE_ID) });
    reg.ingestEvent(f.id, { type: "complete", ok: false, error: "user cancelled" });
    expect(reg.get(f.id)?.state).toBe("error");
    expect(reg.get(f.id)?.errorMessage).toBe("user cancelled");
  });

  test("ingestEvent type=url populates authUrl and moves to awaiting-user", () => {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    reg.ingestEvent(f.id, {
      type: "url",
      url: "https://accounts.google.com/o/oauth2/auth?client_id=…",
    });
    const flow = reg.get(f.id);
    expect(flow?.authUrl).toBe("https://accounts.google.com/o/oauth2/auth?client_id=…");
    expect(flow?.state).toBe("awaiting-user");
  });

  test("ingestEvent type=widget populates the widget config and moves to awaiting-user", () => {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    reg.ingestEvent(f.id, {
      type: "widget",
      kind: "snaptrade-connect",
      payload: { link_token: "link-sandbox-abc" },
    });
    const flow = reg.get(f.id);
    expect(flow?.widget).toEqual({
      kind: "snaptrade-connect",
      payload: { link_token: "link-sandbox-abc" },
    });
    expect(flow?.state).toBe("awaiting-user");
  });

  test("complete with accountIds resolves all ids; accountId mirrors the first", () => {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    reg.ingestEvent(f.id, {
      type: "complete",
      ok: true,
      accountId: "item-1",
      accountIds: ["item-1", "item-2", "item-3"],
    });
    const flow = reg.get(f.id);
    expect(flow?.state).toBe("completed");
    expect(flow?.resolvedAccountIds).toEqual(["item-1", "item-2", "item-3"]);
    expect(flow?.resolvedAccountId).toBe("item-1");
  });

  test("complete with only the scalar accountId still resolves a one-element set", () => {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    reg.ingestEvent(f.id, { type: "complete", ok: true, accountId: "solo@example.com" });
    const flow = reg.get(f.id);
    expect(flow?.resolvedAccountId).toBe("solo@example.com");
    expect(flow?.resolvedAccountIds).toEqual(["solo@example.com"]);
  });

  test("get-on-expiry fans out a synthesised auth.complete{ok:false} to subscribers", async () => {
    const reg = new AuthFlowRegistry({ ttlMs: 5 });
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    const events: Array<{ type: string; ok?: boolean; error?: string }> = [];
    reg.subscribe(f.id, (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.get(f.id)).toBeNull();
    expect(events).toEqual([{ type: "complete", ok: false, error: "expired" }]);
    // After expire, subscribers were dropped — re-emitting nothing further.
    reg.ingestEvent(f.id, { type: "url", url: "x" });
    expect(events).toHaveLength(1);
  });

  test("cleanup() also fans out auth.complete{ok:false,error:'expired'} to subscribers", async () => {
    const reg = new AuthFlowRegistry({ ttlMs: 5 });
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    const events: Array<{ type: string; ok?: boolean; error?: string }> = [];
    reg.subscribe(f.id, (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.cleanup()).toBe(1);
    expect(events).toEqual([{ type: "complete", ok: false, error: "expired" }]);
  });
});

describe("a typed challenge on the record", () => {
  const redirect = {
    kind: "redirect" as const,
    via: "loopback" as const,
    title: "Sign in",
    url: "https://example.org/authorize",
  };

  function pending(expectsAnswer?: boolean) {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    reg.ingestEvent(f.id, {
      type: "challenge",
      id: "c1",
      challenge: redirect,
      ...(expectsAnswer === undefined ? {} : { expectsAnswer }),
    });
    return reg.get(f.id)!.pendingChallenge;
  }

  test("keeps whether an answer is wanted, so a replay tells a late client too", () => {
    expect(pending(true)?.expectsAnswer).toBe(true);
    expect(pending(false)?.expectsAnswer).toBe(false);
  });

  test("assumes an answer is wanted when a collector predates the field", () => {
    expect(pending(undefined)?.expectsAnswer).toBe(true);
  });
});

describe("delivering a code to a flow", () => {
  function flowShowing(expectsAnswer: boolean) {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    reg.ingestEvent(f.id, {
      type: "challenge",
      id: "c1",
      expectsAnswer,
      challenge: {
        kind: "redirect",
        via: "loopback",
        title: "Sign in",
        url: "https://example.org/authorize",
      },
    });
    return { reg, id: f.id };
  }

  test("refuses one the flow is not asking for", () => {
    const { reg, id } = flowShowing(false);
    const latch = reg.acceptCodeDelivery(id);
    expect(latch.ok).toBe(false);
    expect(latch.ok === false && latch.reason).toBe("not-a-question");
    // And the record is untouched: latching it to `completing` would say the
    // flow is finishing while the provider's own listener still waits.
    expect(reg.get(id)?.state).toBe("awaiting-user");
  });

  test("accepts one it is asking for", () => {
    const { reg, id } = flowShowing(true);
    expect(reg.acceptCodeDelivery(id).ok).toBe(true);
    expect(reg.get(id)?.state).toBe("completing");
  });

  test("still accepts one for a flow on the older event shape", () => {
    const reg = new AuthFlowRegistry();
    const f = reg.start({ sourceType: SourceType("gmail"), deviceId: DeviceId(TEST_DEVICE_ID) });
    reg.ingestEvent(f.id, { type: "url", url: "https://example.org/authorize" });
    expect(reg.acceptCodeDelivery(f.id).ok).toBe(true);
  });
});
