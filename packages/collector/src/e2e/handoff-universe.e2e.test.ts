// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Handoff sources: one device syncs at a time, on one shared cursor.
 *
 * The `handoff` universe puts two collectors on one Gmail account declared
 * `handoff`. The harness runs a real `SyncEngine` per collector, so every
 * tick goes through the collector's own lease branch: the tick claims the
 * source's sync lease, syncs when it is granted, and skips silently when
 * another device holds it. The invariants pinned here are the ones a
 * handoff must keep — the source has one `sync_state` row (the shared row,
 * `device_id = ''`) whichever device syncs it, a skipped tick reports
 * nothing and writes nothing, a sibling taking over after a lapse or a
 * release continues from the shared cursor instead of bootstrapping again,
 * and the corpus is the fixture set throughout. The lease's own protocol
 * — the holder's pages renewing it, a non-holder's page refused, the
 * online incumbent's grace window, Sync now dispatched to the holder — is
 * asserted over raw HTTP in `sync-lease.e2e`; a cross-collector add's 409
 * and the explicit owner move in `source-ownership.e2e`. The harness keeps
 * production-like collector connections open. The lapse test disconnects
 * the holder explicitly before proving that the sibling's next claim wins.
 */
import "./synth-env.js";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyncError } from "@omnesis/types";
import { loadSourceFixtureJson, loadUniverse } from "@omnesis/providers-synth-common";
import { SyntheticE2EHarness, type HarnessDevice } from "./synth-harness.js";
import { getDocumentCount } from "./helpers.js";
import { waitForCondition } from "./multi-collector-harness.js";
import type { StatusChangeEvent } from "../sync-engine.js";

const UNIVERSE = "handoff";
const GMAIL = "gmail:john.smith@example.com";
const FIXTURE_COUNT = loadSourceFixtureJson<unknown[]>(
  loadUniverse(UNIVERSE),
  "gmail",
  "messages.json",
).length;
/** Short enough to watch a lease lapse; above the collector's heartbeat floor. */
const LEASE_TTL_MS = 8_000;

interface SourceRow {
  id: string;
  deviceId: string;
  members?: string[];
  multiDeviceMode?: string;
  leaseHolder: string | null;
}
interface SyncStateRow {
  device_id: string;
  last_synced_at: string | null;
}

describe("handoff universe — one device syncs at a time", () => {
  let harness: SyntheticE2EHarness;
  let owner: HarnessDevice;
  let member: HarnessDevice;

  const sourceRow = async (): Promise<SourceRow> => {
    const { items } = await harness.gatewayJson<{ items: SourceRow[] }>("/admin/sources");
    const row = items.find((s) => s.id === GMAIL);
    if (!row) throw new Error(`${GMAIL} is not registered`);
    return row;
  };
  const leaseHolder = async () => (await sourceRow()).leaseHolder;
  const deviceOnline = async (device: HarnessDevice): Promise<boolean> => {
    const { items } = await harness.gatewayJson<{
      items: Array<{ id: string; online: boolean }>;
    }>("/admin/devices");
    return items.find((item) => item.id === device.deviceId)?.online ?? false;
  };
  const count = () => getDocumentCount(harness.gatewayUrl, harness.apiKey, GMAIL);
  /** The source's cursor rows as stored: a handoff source keeps the shared one only. */
  const syncStateRows = (): SyncStateRow[] => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<
          [string],
          SyncStateRow
        >("SELECT device_id, last_synced_at FROM sync_state WHERE source_id = ? ORDER BY device_id")
        .all(GMAIL);
    } finally {
      db.close();
    }
  };
  /** The cursor a device reads — the shared row, for a handoff source. */
  const cursorAs = async (device: HarnessDevice) => {
    const res = await fetch(`${harness.gatewayUrl}/sync-state/${encodeURIComponent(GMAIL)}`, {
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { cursor: unknown; lastSyncedAt: string | null };
  };
  const localState = (device: HarnessDevice) =>
    device.engine.getStatuses().find((s) => s.sourceId === GMAIL)?.state;
  /** Record a device's status events for the source until `stop` is called. */
  const recordEvents = (device: HarnessDevice) => {
    const events: StatusChangeEvent[] = [];
    const stop = harness.onStatusChange((change, from) => {
      if (from === device && change.sourceId === GMAIL) events.push(change);
    });
    return { events, stop };
  };
  /** A tick whose sync ran to completion, with what it reported. */
  const completedTick = async (device: HarnessDevice) => {
    const { events, stop } = recordEvents(device);
    try {
      await harness.triggerSyncAndWait(GMAIL, 60_000, device);
    } finally {
      stop();
    }
    const completed = events.find((e) => e.event === "sync.completed");
    expect(completed, `${device.rosterId} completed its sync`).toBeDefined();
    return completed!.status.lastSyncStats!;
  };
  /**
   * A tick another device's lease turns away: the trigger marks the source
   * syncing, the collector's lease claim is refused, and the source is idle
   * again without a status event.
   */
  const skippedTick = async (device: HarnessDevice) => {
    const { events, stop } = recordEvents(device);
    try {
      expect(device.engine.triggerSync(GMAIL).triggered).toEqual([GMAIL]);
      await waitForCondition(
        async () => localState(device) === "idle",
        10_000,
        `${device.rosterId}'s skipped tick settled`,
      );
    } finally {
      stop();
    }
    expect(events).toEqual([]);
  };

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: UNIVERSE,
      extraGatewayConfig: { multiDevice: { leaseTtl: `${LEASE_TTL_MS}ms` } },
    });
    await harness.start();
    [owner, member] = harness.devicesForSource(GMAIL) as [HarnessDevice, HarnessDevice];
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("both collectors host the source; nothing holds the lease before a tick", async () => {
    expect([owner.rosterId, member.rosterId]).toEqual(["macbook", "imac"]);
    const row = await sourceRow();
    expect(row.multiDeviceMode).toBe("handoff");
    expect(row.deviceId).toBe(owner.deviceId);
    expect(row.members).toEqual([owner.deviceId, member.deviceId]);
    expect(row.leaseHolder).toBeNull();
    // Registration seeds the shared cursor row; a member adds no row of its own.
    expect(syncStateRows()).toEqual([{ device_id: "", last_synced_at: null }]);
    // The account's other sources stay exclusive to the owner.
    expect(
      harness.devicesForSource("google-calendar:john.smith@example.com").map((d) => d.rosterId),
    ).toEqual(["macbook"]);
  });

  test("the owner's tick takes the lease, syncs the fixture set and leaves one shared cursor row", async () => {
    const stats = await completedTick(owner);
    expect(stats.documents).toBe(FIXTURE_COUNT);
    expect(await count()).toBe(FIXTURE_COUNT);
    expect(await leaseHolder()).toBe(owner.deviceId);
    const rows = syncStateRows();
    expect(rows.map((r) => r.device_id)).toEqual([""]);
    expect(rows[0]!.last_synced_at).not.toBeNull();
    expect((await cursorAs(owner)).cursor).toEqual({ offset: FIXTURE_COUNT });
  }, 90_000);

  test("the member's tick while the owner holds the lease is skipped: no event, no write, same holder", async () => {
    const before = syncStateRows();
    // The owner's claim restarts its window, so the tick below lands while
    // the lease is held whatever the box's pace.
    await owner.gateway.claimSyncLease(GMAIL as never);
    await skippedTick(member);
    expect(await leaseHolder()).toBe(owner.deviceId);
    expect(await count()).toBe(FIXTURE_COUNT);
    expect(syncStateRows()).toEqual(before);
  }, 60_000);

  test("once the lease lapses the member's tick claims it and continues from the shared cursor", async () => {
    const before = syncStateRows();
    // A production collector normally stays online after its sync and earns
    // the incumbent grace window. Disconnect it deliberately: this case is
    // specifically about takeover after the holder goes offline.
    expect(owner.ws).toBeDefined();
    owner.ws!.disconnect();
    await waitForCondition(
      async () => !(await deviceOnline(owner)),
      10_000,
      "the owner collector disconnected",
    );
    // The owner's completed sync stopped renewing; once its short lease
    // lapses, the offline holder no longer blocks the sibling's next claim.
    await waitForCondition(
      async () => (await leaseHolder()) === null,
      LEASE_TTL_MS + 10_000,
      "the owner's lease lapsed",
    );
    // The member reads the shared cursor before it syncs.
    expect((await cursorAs(member)).cursor).toEqual({ offset: FIXTURE_COUNT });

    const stats = await completedTick(member);
    expect(await leaseHolder()).toBe(member.deviceId);
    // Continued, not bootstrapped: the page after the shared cursor is empty.
    expect(stats.documents).toBe(0);
    expect(stats.pages).toBe(1);
    expect(await count()).toBe(FIXTURE_COUNT);
    const rows = syncStateRows();
    expect(rows.map((r) => r.device_id)).toEqual([""]);
    expect(rows[0]!.last_synced_at! > before[0]!.last_synced_at!).toBe(true);
    expect((await cursorAs(member)).cursor).toEqual({ offset: FIXTURE_COUNT });
  }, 90_000);

  test("a holder whose credentials fail gives the lease up at once; the sibling's next tick takes over", async () => {
    const registered = member.engine.registeredSources().find((r) => r.source.id === GMAIL);
    expect(registered).toBeDefined();
    const instance = registered!.source.instance;
    const sync = instance.sync;
    instance.sync = async () => {
      throw new SyncError("auth", "the account's token was revoked");
    };
    try {
      const { events, stop } = recordEvents(member);
      try {
        await harness.triggerSyncAndWait(GMAIL, 60_000, member);
      } finally {
        stop();
      }
      expect(events.map((e) => e.event)).toEqual(["sync.started", "sync.error"]);
      expect(localState(member)).toBe("needs-auth");
      // Well inside the lease's TTL, so a lapse alone could not satisfy it.
      await waitForCondition(
        async () => (await leaseHolder()) === null,
        3_000,
        "the failing member released the lease",
      );
    } finally {
      instance.sync = sync;
    }

    const stats = await completedTick(owner);
    expect(await leaseHolder()).toBe(owner.deviceId);
    expect(stats.documents).toBe(0);
    expect(await count()).toBe(FIXTURE_COUNT);
    expect(syncStateRows().map((r) => r.device_id)).toEqual([""]);
  }, 90_000);

  test("a detached member leaves the owner syncing; rejoined, its tick is skipped while the owner holds the lease", async () => {
    const detached = await harness.gatewayJson<{ members: string[]; source: SourceRow }>(
      `/admin/sources/${encodeURIComponent(GMAIL)}/members/${member.deviceId}`,
      { method: "DELETE" },
    );
    expect(detached.members).toEqual([owner.deviceId]);
    expect(detached.source.deviceId).toBe(owner.deviceId);

    const stats = await completedTick(owner);
    expect(stats.documents).toBe(0);
    expect(await leaseHolder()).toBe(owner.deviceId);
    expect(await count()).toBe(FIXTURE_COUNT);

    const rejoined = await member.gateway.bulkUpsertSources([
      {
        type: GMAIL.slice(0, GMAIL.indexOf(":")),
        accountId: GMAIL.slice(GMAIL.indexOf(":") + 1),
        enabled: true,
      } as never,
    ]);
    expect(rejoined.errors).toEqual([]);
    expect((await sourceRow()).members).toEqual([owner.deviceId, member.deviceId]);

    await owner.gateway.claimSyncLease(GMAIL as never);
    await skippedTick(member);
    expect(await leaseHolder()).toBe(owner.deviceId);
    expect(await count()).toBe(FIXTURE_COUNT);
    expect(syncStateRows().map((r) => r.device_id)).toEqual([""]);
  }, 90_000);
});
