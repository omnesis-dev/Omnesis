// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { gatewayVersionNotice, hasActiveFailure, warningFor } from "./status-presentation.js";
import type { CaptureStatus } from "./status.js";

function status(over: Partial<CaptureStatus>): CaptureStatus {
  return {
    paired: true,
    gatewayUrl: "https://gateway.example.com",
    gatewayVersion: null,
    extensionVersion: null,
    pairedAt: 1,
    scopeOk: true,
    hostPermissionOk: true,
    queueDepth: 0,
    health: null,
    failure: null,
    retry: null,
    queueCorruption: null,
    queueOverflow: null,
    handoffFailure: null,
    handoffOverflow: null,
    serverState: null,
    connectivity: null,
    pause: { paused: false, until: null },
    policyLoaded: true,
    recent: [],
    lastSyncAt: null,
    lastCheckedAt: null,
    ...over,
  };
}

describe("capture status presentation", () => {
  // A browser that has never paired holds no scope and no settings, exactly as
  // a freshly installed one does. That is not a fault to report; the same
  // values once a pairing exists are.
  it("calls a missing scope a fault only for a browser that has paired", () => {
    const fresh = status({
      paired: false,
      gatewayUrl: null,
      pairedAt: null,
      scopeOk: false,
      policyLoaded: false,
    });
    expect(warningFor(fresh)).toBe("");
    expect(hasActiveFailure(fresh)).toBe(false);

    expect(warningFor(status({ scopeOk: false }))).toMatch(/scope/i);
    expect(hasActiveFailure(status({ scopeOk: false }))).toBe(true);
  });

  it("renders a usable warning for every warning branch", () => {
    const warningStates: CaptureStatus[] = [
      status({ health: { ok: false, reason: "invented", at: 1 } }),
      status({ scopeOk: false }),
      status({ hostPermissionOk: false }),
      status({ handoffFailure: { at: 1, attempts: 2 } }),
      status({ serverState: { state: "paused", reason: "invented", at: 1 } }),
      status({
        retry: {
          itemId: "doc:1",
          kind: "document",
          status: 503,
          reason: "invented",
          attempts: 2,
          nextRetryAt: 10,
          at: 1,
        },
      }),
      status({ connectivity: { reachable: false, at: 1 } }),
      status({ connectivity: { reachable: true, degraded: true, at: 1 } }),
      status({ queueCorruption: { at: 1, discarded: 2 } }),
      status({ queueOverflow: { at: 1, discardedDocuments: 1, discardedVisits: 2 } }),
      status({ handoffOverflow: { at: 1, discarded: 2 } }),
      status({ failure: { kind: "document", status: 422, reason: "invented", at: 1, count: 1 } }),
    ];
    for (const value of warningStates) expect(warningFor(value).trim()).not.toBe("");
  });

  it("gives gateway health priority over lower-priority warnings", () => {
    const health = { ok: false, reason: "invented health reason", at: 1 };
    const combined = status({
      health,
      scopeOk: false,
      hostPermissionOk: false,
      connectivity: { reachable: false, at: 1 },
    });
    expect(warningFor(combined)).toBe(warningFor(status({ health })));
  });

  it("gives authoritative source state priority over an obsolete retry", () => {
    const serverState = { state: "paused" as const, reason: "invented pause", at: 2 };
    const retry = {
      itemId: "doc:1",
      kind: "document" as const,
      status: 503,
      reason: "invented old failure",
      attempts: 1,
      nextRetryAt: 10,
      at: 1,
    };
    expect(warningFor(status({ serverState, retry }))).toBe(warningFor(status({ serverState })));
  });

  it("treats missing Chrome page access as an active failure", () => {
    const value = status({ hostPermissionOk: false });
    expect(hasActiveFailure(value)).toBe(true);
  });

  it("shows a retained 503 as an active retry rather than false-green sync", () => {
    const value = status({
      retry: {
        itemId: "doc:1",
        kind: "document",
        status: 503,
        reason: "temporarily unavailable",
        attempts: 2,
        nextRetryAt: 10,
        at: 1,
      },
    });
    expect(hasActiveFailure(value)).toBe(true);
    expect(warningFor(value)).not.toBe("");
  });

  it("keeps an acknowledged-capable loss notice without claiming sync remains broken", () => {
    const value = status({
      failure: { kind: "document", status: 422, reason: "invalid payload", at: 1, count: 1 },
    });
    expect(hasActiveFailure(value)).toBe(false);
    expect(warningFor(value)).not.toBe("");
  });

  it("treats a missing settings copy as an active failure, but not while unpaired", () => {
    const missing = status({ policyLoaded: false });
    expect(hasActiveFailure(missing)).toBe(true);
    expect(warningFor(missing)).toMatch(/Capture settings have not been loaded/);
    const unpaired = status({ paired: false, policyLoaded: false });
    expect(hasActiveFailure(unpaired)).toBe(false);
    expect(warningFor(unpaired)).toBe("");
  });

  it("surfaces an inconclusive gateway check as active degradation", () => {
    const value = status({
      connectivity: { reachable: true, degraded: true, reason: "HTTP 503", at: 1 },
    });
    expect(hasActiveFailure(value)).toBe(true);
  });
});

describe("gatewayVersionNotice", () => {
  it("says nothing when either version is unknown or the two are compatible", () => {
    expect(gatewayVersionNotice(null, "0.4.5")).toBe("");
    expect(gatewayVersionNotice("0.4.5", null)).toBe("");
    expect(gatewayVersionNotice("garbage", "0.4.5")).toBe("");
    // Same minor, any patch: HTTP changes within a minor are additive.
    expect(gatewayVersionNotice("0.4.1", "0.4.5")).toBe("");
    expect(gatewayVersionNotice("0.4.9", "0.4.5")).toBe("");
    // A gateway ahead of the extension is fine too.
    expect(gatewayVersionNotice("0.6.0", "0.4.5")).toBe("");
  });

  it("warns when the gateway is a minor behind, and when the majors differ", () => {
    expect(gatewayVersionNotice("0.3.9", "0.4.5")).toMatch(
      /behind this extension.*Update the gateway/,
    );
    expect(gatewayVersionNotice("1.0.0", "0.4.5")).toMatch(/different major versions/);
    expect(gatewayVersionNotice("0.4.5", "1.0.0")).toMatch(/different major versions/);
  });

  it("is the lowest-priority warning in the popup ladder", () => {
    const skewed = status({ gatewayVersion: "0.3.0", extensionVersion: "0.4.5" });
    expect(warningFor(skewed)).toMatch(/behind this extension/);
    // Informational: the state stays Ready, not "Not syncing".
    expect(hasActiveFailure(skewed)).toBe(false);
    expect(warningFor(status({ ...skewed, connectivity: { reachable: false, at: 1 } }))).toMatch(
      /Can't reach the gateway/,
    );
  });
});
