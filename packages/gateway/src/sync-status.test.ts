// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { SourceId, DeviceId } from "@omnesis/types";
import {
  SyncStatusRegistry,
  deriveDisplayStatus,
  isSourceFeedStale,
  FRESHNESS_READING_MAX_AGE_MS,
} from "./sync-status.js";
import type { SourceSyncStatus } from "./sync-status.js";
import type { StoredSyncState } from "./db.js";

const src = SourceId("test-source:acct1");
// Fake but well-formed UUID — DeviceId() now validates UUID-v4 shape.
const dev = DeviceId("11111111-1111-4111-8111-111111111111");

function mk(reg: SyncStatusRegistry): void {
  reg.update({
    sourceId: src,
    deviceId: dev,
    state: "completed",
    lastUpdated: Date.now(),
  });
}

describe("SyncStatusRegistry", () => {
  test("update then get returns the status", () => {
    const r = new SyncStatusRegistry();
    mk(r);
    expect(r.get(src)?.state).toBe("completed");
  });

  test("remove tombstones the sourceId — subsequent update is dropped", () => {
    const r = new SyncStatusRegistry();
    mk(r);
    expect(r.get(src)).toBeDefined();

    r.remove(src);
    expect(r.get(src)).toBeUndefined();

    // Stale event arriving after the remove — must NOT repopulate.
    r.update({
      sourceId: src,
      deviceId: dev,
      state: "completed",
      lastUpdated: Date.now(),
    });
    expect(r.get(src)).toBeUndefined();
  });

  test("clearTombstone allows re-adding the same sourceId", () => {
    const r = new SyncStatusRegistry();
    mk(r);
    r.remove(src);
    r.clearTombstone(src);

    r.update({
      sourceId: src,
      deviceId: dev,
      state: "syncing",
      lastUpdated: Date.now(),
    });
    expect(r.get(src)?.state).toBe("syncing");
  });

  test("remove preserves tombstone even without explicit update — isolation", () => {
    const r = new SyncStatusRegistry();
    r.remove(src); // remove before any update — should still tombstone
    r.update({
      sourceId: src,
      deviceId: dev,
      state: "completed",
      lastUpdated: Date.now(),
    });
    expect(r.get(src)).toBeUndefined();
  });

  test("a source with several reporting members aggregates: syncing wins, then the latest report", () => {
    const r = new SyncStatusRegistry();
    const dev2 = DeviceId("22222222-2222-4222-8222-222222222222");
    r.update({ sourceId: src, deviceId: dev, state: "completed", lastUpdated: 1 });
    r.update({ sourceId: src, deviceId: dev2, state: "syncing", lastUpdated: 2 });
    expect(r.get(src)?.deviceId).toBe(dev2);
    expect(r.get(src)?.state).toBe("syncing");
    expect(r.listMembers(src).map((m) => m.deviceId)).toEqual([dev, dev2]);
    // Only one entry per source in the flat listing.
    expect(r.list().filter((s) => s.sourceId === src)).toHaveLength(1);

    r.update({ sourceId: src, deviceId: dev2, state: "completed", lastUpdated: 3 });
    r.update({ sourceId: src, deviceId: dev, state: "error", lastUpdated: 4 });
    // Nobody is syncing: the most recent report represents the source.
    expect(r.get(src)?.deviceId).toBe(dev);
    expect(r.get(src)?.state).toBe("error");
    r.remove(src);
    expect(r.listMembers(src)).toEqual([]);
  });

  test("a sparse update without a device merges into a single member's entry", () => {
    const r = new SyncStatusRegistry();
    mk(r);
    r.update({ sourceId: src, state: "syncing", lastUpdated: Date.now() });
    expect(r.listMembers(src)).toHaveLength(1);
    expect(r.get(src)?.deviceId).toBe(dev);
    expect(r.get(src)?.state).toBe("syncing");
  });

  test("deviceFor returns the last reporting device", () => {
    const r = new SyncStatusRegistry();
    mk(r);
    expect(r.deviceFor(src)).toBe(dev);
  });

  // providerId carries the `<providerType>:<accountId>` form the collector
  // attaches to every SourceStatus. Renderers (CLI status, portal /sources)
  // group `needs-auth` rows by it so a Google revoke shows ONE
  // re-auth hint instead of one per Gmail/Calendar/Contacts/Drive — closes
  // cli-reauth-hint-per-source-instead-of-per-provider.
  test("providerId is preserved across sparse updates", () => {
    const r = new SyncStatusRegistry();
    r.update({
      sourceId: src,
      deviceId: dev,
      providerId: "test-provider:acct1",
      state: "completed",
      lastUpdated: Date.now(),
    });
    expect(r.get(src)?.providerId).toBe("test-provider:acct1");

    // A subsequent update without providerId must NOT clear the cached one
    // — sparse `sync.progress` events should preserve identity.
    r.update({
      sourceId: src,
      deviceId: dev,
      state: "syncing",
      lastUpdated: Date.now(),
    });
    expect(r.get(src)?.providerId).toBe("test-provider:acct1");
  });
});

// ── Canonical display state derivation ──────────────────────────────────────
//
// The gateway derives a single display state from three independent inputs:
//   - in-memory live event (transient, lost on restart)
//   - persisted `sync_state` row (survives restart)
//   - registered source row (carries `enabled` flag)
//
// Both portal and CLI render this state directly without re-mapping, so
// they stay in lockstep.

function inMem(
  state: SourceSyncStatus["state"],
  extra: Partial<SourceSyncStatus> = {},
): SourceSyncStatus {
  return {
    sourceId: src,
    deviceId: dev,
    state,
    lastUpdated: Date.now(),
    ...extra,
  };
}

function persisted(extra: Partial<StoredSyncState> = {}): StoredSyncState {
  return {
    source_id: src,
    cursor: "{}",
    last_synced_at: null,
    icon: null,
    label: null,
    url_patterns: null,
    last_error: null,
    errored_at: null,
    last_error_remediation: null,
    consent_expires_at: null,
    last_document_at: null,
    ...extra,
  };
}

describe("deriveDisplayStatus", () => {
  test("overlays a fresh actionable permission state on an otherwise healthy source", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({ last_synced_at: "2026-04-25T12:00:00Z" }),
      { enabled: true },
      2_000,
      {
        state: "background-access-missing",
        reportedState: "background-access-missing",
        checkedAt: 1_000,
        receivedAt: 1_000,
        validUntil: 60_000,
        reportStale: false,
        capabilities: [],
      },
    );
    expect(out.state).toBe("background-access-missing");
  });

  test("does not overlay an actionable state from a stale permission report", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({ last_synced_at: "2026-04-25T12:00:00Z" }),
      { enabled: true },
      70_000,
      {
        state: "unknown",
        reportedState: "unavailable",
        checkedAt: 1_000,
        receivedAt: 1_000,
        validUntil: 60_000,
        reportStale: true,
        capabilities: [],
      },
    );
    expect(out.state).toBe("synced");
    expect(out.permissionHealth?.reportStale).toBe(true);
  });

  test("a source the collector cannot host reads as its error, never as idle", () => {
    // A source that never instantiated has no cursor, no last sync and no
    // history — every ingredient of `idle`. What separates it is the collector
    // saying so; without that the operator sees healthy-and-waiting forever.
    const live = deriveDisplayStatus(
      src,
      inMem("error", { errorMessage: "Cannot open the local store. Grant access to the daemon." }),
      persisted(),
      { enabled: true },
    );
    expect(live.state).toBe("error");
    expect(live.errorMessage).toMatch(/Grant access to the daemon/);

    // And it survives a gateway restart, which drops the in-memory registry.
    const afterRestart = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        last_error: "Cannot open the local store. Grant access to the daemon.",
        errored_at: "2026-04-25T12:00:00Z",
      }),
      { enabled: true },
    );
    expect(afterRestart.state).toBe("error");
    expect(afterRestart.errorMessage).toMatch(/Grant access to the daemon/);
  });

  test("paused wins over everything (enabled=false → state=paused)", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("syncing"),
      persisted({ last_synced_at: "2026-04-25T12:00:00Z" }),
      { enabled: false },
    );
    expect(out.state).toBe("paused");
  });

  test("paused state preserves lastSyncAt — pause keeps cursor + history visible", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({ last_synced_at: "2026-04-25T12:00:00Z" }),
      { enabled: false },
    );
    expect(out.state).toBe("paused");
    expect(out.lastSyncAt).toBe("2026-04-25T12:00:00Z");
  });

  test("resume (enabled=true again) drops back to synced when persisted timestamp exists", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({ last_synced_at: "2026-04-25T12:00:00Z" }),
      { enabled: true },
    );
    expect(out.state).toBe("synced");
  });

  test("syncing wins over persisted synced — sync in progress takes priority", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("syncing"),
      persisted({ last_synced_at: "2026-04-25T12:00:00Z" }),
      { enabled: true },
    );
    expect(out.state).toBe("syncing");
    // lastSyncAt still surfaces the previous successful timestamp
    expect(out.lastSyncAt).toBe("2026-04-25T12:00:00Z");
  });

  test("deriveDisplayStatus surfaces providerId from in-memory state", () => {
    // The renderer needs providerId to group needs-auth rows by provider
    // account (one re-auth hint per provider, not per source). Cf.
    // cli-reauth-hint-per-source-instead-of-per-provider.
    const out = deriveDisplayStatus(
      src,
      inMem("syncing", { providerId: "test-provider:acct1" }),
      persisted({}),
      { enabled: true },
    );
    expect(out.providerId).toBe("test-provider:acct1");
  });

  test("in-memory error → state=error with both message and timestamp", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("error", { errorMessage: "auth expired" }),
      persisted({ last_synced_at: "2026-04-25T11:00:00Z" }),
      { enabled: true },
    );
    expect(out.state).toBe("error");
    expect(out.errorMessage).toBe("auth expired");
    expect(out.erroredAt).toBeTruthy();
  });

  test("persisted error survives gateway restart (no in-memory event)", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        last_synced_at: "2026-04-25T11:00:00Z",
        last_error: "rate limited",
        errored_at: "2026-04-25T12:00:00Z",
      }),
      { enabled: true },
    );
    expect(out.state).toBe("error");
    expect(out.errorMessage).toBe("rate limited");
    expect(out.erroredAt).toBe("2026-04-25T12:00:00Z");
  });

  test("synced when last_synced_at exists and no error/in-progress signal", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({ last_synced_at: "2026-04-25T12:00:00Z" }),
      { enabled: true },
    );
    expect(out.state).toBe("synced");
    expect(out.lastSyncAt).toBe("2026-04-25T12:00:00Z");
    expect(out.errorMessage).toBeUndefined();
  });

  test("in-memory completed (after restart was wiped) still resolves to synced via persisted timestamp", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("completed"),
      persisted({ last_synced_at: "2026-04-25T12:00:00Z" }),
      { enabled: true },
    );
    expect(out.state).toBe("synced");
  });

  test("idle when registered but no persisted timestamp and no in-memory state", () => {
    const out = deriveDisplayStatus(src, undefined, undefined, { enabled: true });
    expect(out.state).toBe("idle");
    expect(out.lastSyncAt).toBeNull();
  });

  test("idle when in-memory says idle and no successful sync persisted", () => {
    const out = deriveDisplayStatus(src, inMem("idle"), undefined, { enabled: true });
    expect(out.state).toBe("idle");
  });

  test("progress + unitName + deviceId are passed through from in-memory", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("syncing", {
        unitName: "email",
        // Canonical SyncProgress shape — same field names the source
        // emits, the collector forwards, and the display layer reads.
        progress: { phase: "bootstrap", total: 100, processed: 42, percentComplete: 42 },
        startedAt: 1234,
      }),
      undefined,
      { enabled: true },
    );
    expect(out.state).toBe("syncing");
    expect(out.unitName).toBe("email");
    expect(out.progress?.processed).toBe(42);
    expect(out.progress?.total).toBe(100);
    expect(out.progress?.percentComplete).toBe(42);
    expect(out.progress?.phase).toBe("bootstrap");
    expect(out.startedAt).toBe(1234);
    expect(out.deviceId).toBe(dev);
  });

  test("no registered source — deriving still works (discovered-only sources)", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("completed"),
      persisted({ last_synced_at: "2026-04-25T12:00:00Z" }),
      undefined,
    );
    expect(out.state).toBe("synced");
  });

  test("in-memory needs-auth → state=needs-auth with hint surfaced as errorMessage", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("needs-auth", {
        errorMessage: "needs reauth: run `cli -- add gmail` to re-authenticate",
      }),
      undefined,
      { enabled: true },
    );
    expect(out.state).toBe("needs-auth");
    expect(out.errorMessage).toContain("re-authenticate");
    expect(out.erroredAt).toBeTruthy();
  });

  test("persisted `needs reauth: ...` (gateway restart) maps to needs-auth, not generic error", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        last_synced_at: "2026-04-25T10:00:00Z",
        last_error: "needs reauth: run `cli -- add gmail` to re-authenticate",
        errored_at: "2026-04-26T11:00:00Z",
      }),
      { enabled: true },
    );
    expect(out.state).toBe("needs-auth");
    expect(out.errorMessage).toContain("re-authenticate");
  });

  test("persisted regular error (no needs-reauth prefix) still maps to generic error", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        last_synced_at: "2026-04-25T10:00:00Z",
        last_error: "rate limited",
        errored_at: "2026-04-26T11:00:00Z",
      }),
      { enabled: true },
    );
    expect(out.state).toBe("error");
    expect(out.errorMessage).toBe("rate limited");
  });

  test("syncing wins over needs-auth — a sync in progress hides the auth pill until it errors out", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("syncing"),
      persisted({
        last_error: "needs reauth: run `cli -- add gmail` to re-authenticate",
        errored_at: "2026-04-26T11:00:00Z",
      }),
      { enabled: true },
    );
    expect(out.state).toBe("syncing");
  });

  test("in-memory rate-limited → state=rate-limited with the back-off note as errorMessage", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("rate-limited", {
        errorMessage: "rate-limited: rate limited; retrying in ~6h — ASPSP cap reached",
      }),
      persisted({ last_synced_at: "2026-04-25T11:00:00Z" }),
      { enabled: true },
    );
    expect(out.state).toBe("rate-limited");
    expect(out.errorMessage).toContain("retrying in ~6h");
    expect(out.erroredAt).toBeTruthy();
    // A rate-limit is not a failure — the prior successful timestamp stays visible.
    expect(out.lastSyncAt).toBe("2026-04-25T11:00:00Z");
  });

  test("persisted `rate-limited: ...` (gateway restart) maps to rate-limited, not generic error", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        last_synced_at: "2026-04-25T10:00:00Z",
        last_error: "rate-limited: rate limited; retrying in ~6h",
        errored_at: "2026-04-26T11:00:00Z",
      }),
      { enabled: true },
    );
    expect(out.state).toBe("rate-limited");
    expect(out.errorMessage).toContain("retrying in");
  });

  test("syncing wins over rate-limited — an in-flight retry hides the deferral pill", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("syncing"),
      persisted({
        last_error: "rate-limited: rate limited; retrying in ~6h",
        errored_at: "2026-04-26T11:00:00Z",
      }),
      { enabled: true },
    );
    expect(out.state).toBe("syncing");
  });

  test("in-memory needs-auth wins over a stale persisted regular error", () => {
    // Source was hard-erroring; user re-auth attempt fails (provider
    // re-auth still bad); sync-engine flips in-memory to needs-auth. The
    // display should reflect needs-auth, not the older generic error.
    const out = deriveDisplayStatus(
      src,
      inMem("needs-auth", {
        errorMessage: "needs reauth: run `cli -- add gmail` to re-authenticate",
      }),
      persisted({ last_error: "rate limited", errored_at: "2026-04-25T11:00:00Z" }),
      { enabled: true },
    );
    expect(out.state).toBe("needs-auth");
  });
});

// Forward-looking consent-expiry. `auth-expiring` is a purely DERIVED
// display state computed from the persisted `consent_expires_at` and a clock —
// never a persisted SourceSyncState. It only upgrades an otherwise-healthy
// source (synced / idle) and must never mask syncing / paused / needs-auth /
// error / rate-limited. `now` is injected so the threshold is deterministic.
describe("deriveDisplayStatus — forward-looking consent-expiry", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-04-25T12:00:00Z");

  test("synced source flips to auth-expiring inside the 14-day lead window", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        last_synced_at: "2026-04-25T11:00:00Z",
        // 10 days out — inside the 14-day window.
        consent_expires_at: new Date(now + 10 * DAY).toISOString(),
      }),
      { enabled: true },
      now,
    );
    expect(out.state).toBe("auth-expiring");
    expect(out.consentExpiresAt).toBe(new Date(now + 10 * DAY).toISOString());
  });

  test("normal sync does NOT raise the flag — deadline well outside the window", () => {
    const deadline = new Date(now + 60 * DAY).toISOString();
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({ last_synced_at: "2026-04-25T11:00:00Z", consent_expires_at: deadline }),
      { enabled: true },
      now,
    );
    expect(out.state).toBe("synced");
    // The deadline is still surfaced so a client can show "expires on <date>".
    expect(out.consentExpiresAt).toBe(deadline);
  });

  test("no deadline stored → plain synced, no consentExpiresAt", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({ last_synced_at: "2026-04-25T11:00:00Z" }),
      { enabled: true },
      now,
    );
    expect(out.state).toBe("synced");
    expect(out.consentExpiresAt).toBeUndefined();
  });

  test("exactly at the lead-window boundary qualifies (>= deadline - window)", () => {
    const deadline = new Date(now + 14 * DAY).toISOString();
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({ last_synced_at: "2026-04-25T11:00:00Z", consent_expires_at: deadline }),
      { enabled: true },
      now,
    );
    expect(out.state).toBe("auth-expiring");
  });

  test("warning persists across restart — derived from persisted row with NO in-memory event", () => {
    // After a gateway restart the in-memory registry is empty; the deadline
    // lives only in the persisted sync_state row. The warning must still derive.
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        last_synced_at: "2026-04-25T11:00:00Z",
        consent_expires_at: new Date(now + 3 * DAY).toISOString(),
      }),
      undefined,
      now,
    );
    expect(out.state).toBe("auth-expiring");
  });

  test("idle source (never synced) also warns when a deadline is already inside the window", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({ consent_expires_at: new Date(now + 5 * DAY).toISOString() }),
      { enabled: true },
      now,
    );
    expect(out.state).toBe("auth-expiring");
  });

  test("terminal needs-auth is NOT masked by an in-window deadline", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("needs-auth", { errorMessage: "needs reauth: run `cli -- reauth plaid` …" }),
      persisted({
        last_synced_at: "2026-04-25T11:00:00Z",
        consent_expires_at: new Date(now + 2 * DAY).toISOString(),
      }),
      { enabled: true },
      now,
    );
    expect(out.state).toBe("needs-auth");
  });

  test("syncing is NOT masked by an in-window deadline", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("syncing"),
      persisted({ consent_expires_at: new Date(now + 2 * DAY).toISOString() }),
      { enabled: true },
      now,
    );
    expect(out.state).toBe("syncing");
  });

  test("paused is NOT masked by an in-window deadline", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        last_synced_at: "2026-04-25T11:00:00Z",
        consent_expires_at: new Date(now + 2 * DAY).toISOString(),
      }),
      { enabled: false },
      now,
    );
    expect(out.state).toBe("paused");
  });

  test("re-consent that pushes the deadline out clears the warning", () => {
    // Same source, new sync reported a deadline far in the future → back to synced.
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        last_synced_at: "2026-04-25T11:00:00Z",
        consent_expires_at: new Date(now + 90 * DAY).toISOString(),
      }),
      { enabled: true },
      now,
    );
    expect(out.state).toBe("synced");
  });

  test("an unparseable deadline never trips the warning", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({ last_synced_at: "2026-04-25T11:00:00Z", consent_expires_at: "not-a-date" }),
      { enabled: true },
      now,
    );
    expect(out.state).toBe("synced");
  });
});

// Staleness detection for sources reading a local file another program keeps
// current. The conjunction is the design: each signal alone is ordinary, and a
// warning that fires on ordinary conditions is one the operator learns to
// ignore. These tests pin every way it must stay silent, because the
// false-positive cases are the ones that would make the feature harmful.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-26T12:00:00.000Z");

function fresh(
  extra: Partial<NonNullable<SourceSyncStatus["freshness"]>> = {},
): NonNullable<SourceSyncStatus["freshness"]> {
  return {
    quietPeriodMs: 14 * DAY_MS,
    hint: "Open the app to resume syncing.",
    processRunning: false,
    ...extra,
  };
}

const longAgo = new Date(NOW - 30 * DAY_MS).toISOString();
const recently = new Date(NOW - 1 * DAY_MS).toISOString();

describe("isSourceFeedStale", () => {
  test("fires when the feed is quiet past its window AND its process is down", () => {
    expect(isSourceFeedStale(fresh(), longAgo, NOW)).toBe(true);
  });

  test("stays silent when the process is running, however long the quiet spell", () => {
    expect(isSourceFeedStale(fresh({ processRunning: true }), longAgo, NOW)).toBe(false);
  });

  test("stays silent when the app is shut but the source produced data recently", () => {
    expect(isSourceFeedStale(fresh(), recently, NOW)).toBe(false);
  });

  test("stays silent for a source that declared no freshness expectation", () => {
    expect(isSourceFeedStale(undefined, longAgo, NOW)).toBe(false);
  });

  // An un-probeable host must not be reported as a broken one: `undefined`
  // means we could not determine whether the process runs, and inventing a
  // warning out of our own blind spot is worse than staying quiet.
  test("stays silent when the process state could not be determined", () => {
    expect(isSourceFeedStale(fresh({ processRunning: undefined }), longAgo, NOW)).toBe(false);
  });

  // NULL last_document_at is also what a just-added source looks like, so it
  // can never on its own be evidence of staleness.
  test("stays silent for a source that has never produced a document", () => {
    expect(isSourceFeedStale(fresh(), null, NOW)).toBe(false);
  });

  test("stays silent on an unparseable timestamp rather than treating it as ancient", () => {
    expect(isSourceFeedStale(fresh(), "not-a-date", NOW)).toBe(false);
  });

  test("does not fire exactly at the window boundary — only strictly past it", () => {
    const atBoundary = new Date(NOW - 14 * DAY_MS).toISOString();
    expect(isSourceFeedStale(fresh(), atBoundary, NOW)).toBe(false);
  });
});

describe("deriveDisplayStatus — stale", () => {
  const staleInputs = {
    inMem: inMem("completed", { freshness: fresh(), lastUpdated: NOW }),
    persisted: persisted({ last_synced_at: recently, last_document_at: longAgo }),
  };

  test("upgrades an otherwise-healthy synced source and carries the source's hint", () => {
    const out = deriveDisplayStatus(
      src,
      staleInputs.inMem,
      staleInputs.persisted,
      { enabled: true },
      NOW,
    );
    expect(out.state).toBe("stale");
    expect(out.staleHint).toBe("Open the app to resume syncing.");
  });

  // The whole point of a separate state is that it must not be confusable with
  // a real failure, nor able to hide one. These four pin that it only ever
  // upgrades a healthy source.
  test("never masks a paused source", () => {
    const out = deriveDisplayStatus(
      src,
      staleInputs.inMem,
      staleInputs.persisted,
      { enabled: false },
      NOW,
    );
    expect(out.state).toBe("paused");
  });

  test("never masks a sync in flight", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("syncing", { freshness: fresh(), lastUpdated: NOW }),
      staleInputs.persisted,
      { enabled: true },
      NOW,
    );
    expect(out.state).toBe("syncing");
  });

  test("never masks a credential failure", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("needs-auth", { freshness: fresh(), lastUpdated: NOW }),
      staleInputs.persisted,
      { enabled: true },
      NOW,
    );
    expect(out.state).toBe("needs-auth");
  });

  test("never masks a hard sync error", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("error", { freshness: fresh(), errorMessage: "boom", lastUpdated: NOW }),
      staleInputs.persisted,
      { enabled: true },
      NOW,
    );
    expect(out.state).toBe("error");
  });

  // A lapsing credential is the more urgent of the two warnings, and the
  // operator can't act on both at once.
  test("yields to an expiring consent deadline", () => {
    const out = deriveDisplayStatus(
      src,
      staleInputs.inMem,
      persisted({
        last_synced_at: recently,
        last_document_at: longAgo,
        consent_expires_at: new Date(NOW + DAY_MS).toISOString(),
      }),
      { enabled: true },
      NOW,
    );
    expect(out.state).toBe("auth-expiring");
  });

  // `idle` is reachable here: the registry emits `sync.completed` carrying state
  // `idle` after a source is reactivated, so the gate must cover both halves.
  test("upgrades an idle source too, not only a synced one", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("idle", { freshness: fresh(), lastUpdated: NOW }),
      persisted({ last_document_at: longAgo }),
      { enabled: true },
      NOW,
    );
    expect(out.state).toBe("stale");
  });

  test("never masks a rate-limited back-off", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("rate-limited", { freshness: fresh(), lastUpdated: NOW }),
      staleInputs.persisted,
      { enabled: true },
      NOW,
    );
    expect(out.state).toBe("rate-limited");
  });

  test("leaves staleHint unset for a healthy source", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("completed", { freshness: fresh({ processRunning: true }), lastUpdated: NOW }),
      staleInputs.persisted,
      { enabled: true },
      NOW,
    );
    expect(out.state).toBe("synced");
    expect(out.staleHint).toBeUndefined();
  });
});

describe("SyncStatusRegistry — freshness", () => {
  test("a fresher reading replaces the previous one", () => {
    const r = new SyncStatusRegistry();
    r.update(inMem("completed", { freshness: fresh() }));
    r.update(inMem("completed", { freshness: fresh({ processRunning: true }) }));
    expect(r.get(src)?.freshness?.processRunning).toBe(true);
  });

  // The collector attaches the declaration to every status event, so its
  // absence means the source stopped making the claim — not that this
  // particular event was sparse. A source reconfigured so that nothing feeds it
  // from an app must stop being reported stale without waiting for a restart.
  test("an event without a declaration clears the previous one", () => {
    const r = new SyncStatusRegistry();
    r.update(inMem("completed", { freshness: fresh() }));
    r.update(inMem("completed"));
    expect(r.get(src)?.freshness).toBeUndefined();
  });
});

// A reading describes what was true on the collector's host when it was taken.
// In a two-machine install the collector can disappear while the gateway stays
// up — and then the last "the app isn't running" reading would sit in memory
// while the data aged, eventually accusing the operator of having quit an app
// when in truth nothing is syncing at all.
describe("isSourceFeedStale — trusting the collector's reading", () => {
  test("a recent reading is trusted", () => {
    expect(isSourceFeedStale(fresh(), longAgo, NOW, NOW - 60_000)).toBe(true);
  });

  test("a reading older than the trust window is ignored", () => {
    const ancient = NOW - (FRESHNESS_READING_MAX_AGE_MS + 60_000);
    expect(isSourceFeedStale(fresh(), longAgo, NOW, ancient)).toBe(false);
  });

  test("an absent reading time keeps the previous behaviour", () => {
    expect(isSourceFeedStale(fresh(), longAgo, NOW, undefined)).toBe(true);
  });

  test("a source whose collector went away does not claim the app was quit", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("completed", {
        freshness: fresh(),
        lastUpdated: NOW - (FRESHNESS_READING_MAX_AGE_MS + 60_000),
      }),
      persisted({ last_synced_at: recently, last_document_at: longAgo }),
      { enabled: true },
      NOW,
    );
    expect(out.state).toBe("synced");
    expect(out.staleHint).toBeUndefined();
  });
});

// ── Structured remediation ──────────────────────────────────────────────────
//
// A failure the operator has to act on travels with its remedy: live on the
// report, persisted beside the message, and dropped with it. The derivation
// must surface it from either input and never invent one.

const REMEDY = {
  summary: "Disk access is required",
  steps: ["Open the pane.", "Add the executable."],
  executable: "/opt/example/bin/node",
  restartRequired: true,
};

describe("deriveDisplayStatus — remediation", () => {
  test("a live error carries the remedy it was reported with", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("error", { errorMessage: "Cannot open the database", remediation: REMEDY }),
      persisted({}),
      { enabled: true },
    );
    expect(out.state).toBe("error");
    expect(out.remediation).toEqual(REMEDY);
  });

  test("a live error without a remedy has none, whatever the row remembers", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("error", { errorMessage: "connection refused" }),
      persisted({
        last_error: "Cannot open the database",
        errored_at: "2026-04-25T12:00:00Z",
        last_error_remediation: JSON.stringify(REMEDY),
      }),
      { enabled: true },
    );
    expect(out.state).toBe("error");
    expect(out.remediation).toBeUndefined();
  });

  test("a persisted remedy survives a gateway restart with its message", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        last_error: "Cannot open the database",
        errored_at: "2026-04-25T12:00:00Z",
        last_error_remediation: JSON.stringify(REMEDY),
      }),
      { enabled: true },
    );
    expect(out.state).toBe("error");
    expect(out.errorMessage).toBe("Cannot open the database");
    expect(out.remediation).toEqual(REMEDY);
  });

  test("a persisted row whose remedy no longer parses reads as no remedy, message intact", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        last_error: "Cannot open the database",
        errored_at: "2026-04-25T12:00:00Z",
        last_error_remediation: "{not json",
      }),
      { enabled: true },
    );
    expect(out.state).toBe("error");
    expect(out.errorMessage).toBe("Cannot open the database");
    expect(out.remediation).toBeUndefined();
  });

  test("a healthy source has no remedy even when a stale column value lingers", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("completed"),
      persisted({
        last_synced_at: "2026-04-25T13:00:00Z",
        last_error_remediation: JSON.stringify(REMEDY),
      }),
      { enabled: true },
    );
    expect(out.state).toBe("synced");
    expect(out.remediation).toBeUndefined();
  });
});

describe("SyncStatusRegistry — remediation", () => {
  test("a later report without a remedy drops the previous one", () => {
    const r = new SyncStatusRegistry();
    r.update({
      sourceId: src,
      deviceId: dev,
      state: "error",
      errorMessage: "Cannot open the database",
      remediation: REMEDY,
      lastUpdated: Date.now(),
    });
    expect(r.get(src)?.remediation).toEqual(REMEDY);
    r.update({
      sourceId: src,
      deviceId: dev,
      state: "error",
      errorMessage: "connection refused",
      lastUpdated: Date.now(),
    });
    expect(r.get(src)?.remediation).toBeUndefined();
  });
});

describe("deriveDisplayStatus — which device a status names", () => {
  test("the live report's device wins", () => {
    const out = deriveDisplayStatus(
      src,
      inMem("error", { errorMessage: "refused" }),
      persisted({
        device_id: "dev-other",
        last_error: "refused",
        errored_at: "2026-04-25T12:00:00Z",
      }),
      { enabled: true },
    );
    expect(out.deviceId).toBe(dev);
  });

  test("without a live report, a member's persisted row names that member", () => {
    const out = deriveDisplayStatus(
      src,
      undefined,
      persisted({
        device_id: "0f7e1c5a-4b2d-4c3e-9a1b-2d3e4f5a6b7c",
        last_error: "refused",
        errored_at: "2026-04-25T12:00:00Z",
      }),
      { enabled: true },
    );
    expect(out.deviceId).toBe("0f7e1c5a-4b2d-4c3e-9a1b-2d3e4f5a6b7c");
  });

  test("the shared row and an unparseable row name no device", () => {
    for (const device_id of ["", "not-a-device-id"]) {
      const out = deriveDisplayStatus(
        src,
        undefined,
        persisted({ device_id, last_error: "refused", errored_at: "2026-04-25T12:00:00Z" }),
        { enabled: true },
      );
      expect(out.deviceId).toBeUndefined();
      expect(out.state).toBe("error");
    }
  });
});
