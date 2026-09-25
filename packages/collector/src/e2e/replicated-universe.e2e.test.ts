// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Replicated sources hold the whole store on every host.
 *
 * The `replicated` universe puts two collectors on one Things source and
 * two phones on one Apple Health source, both declared `replicated`. The
 * harness syncs each source on every host, so the gateway sees what a user
 * with two Macs or two phones produces: each member claims its own write
 * authority, advances its own cursor, and pushes the same replica. The
 * invariants pinned here are the ones a replica must keep — the corpus
 * equals one host's (no duplicates), a snapshot reconcile from either host
 * deletes nothing, cursors never move backwards on any host, and a host
 * leaving (detach, revoke) loses no data and hands the source on. "Sync now"
 * dispatch to every member is asserted on `MultiCollectorHarness`
 * (`source-membership.e2e`), whose collectors hold a WS connection; the
 * roster engines here are in-process, so the gateway sees no member online.
 */
import "./synth-env.js";
import SqliteDatabase from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { loadSourceFixtureJson, loadUniverse } from "@omnesis/providers-synth-common";
import { SyntheticE2EHarness, type HarnessDevice } from "./synth-harness.js";
import { getDocumentCount } from "./helpers.js";
import { waitForCondition } from "./multi-collector-harness.js";

const UNIVERSE = "replicated";
const THINGS = "things:local";
const THINGS_FIXTURE_COUNT = loadSourceFixtureJson<unknown[]>(
  loadUniverse(UNIVERSE),
  "things",
  "tasks.json",
).length;
const HEALTH = "apple-health:ios-synth-johnsmith";
const APPLE_ACCOUNT = "john.smith@icloud.example";
const APPLE_SOURCE_TYPES = [
  "apple-call-log",
  "apple-imessage",
  "apple-notes",
  "apple-reminders",
  "apple-voicemail",
] as const;
const APPLE_SOURCES = APPLE_SOURCE_TYPES.map((type) => `${type}:${APPLE_ACCOUNT}`);
const EXCLUSIVE_APPLE_SOURCES = [
  `apple-calendar:${APPLE_ACCOUNT}`,
  `apple-contacts:${APPLE_ACCOUNT}`,
];
const SCREEN_TIME = `screen-time:${APPLE_ACCOUNT}`;

interface SourceRow {
  id: string;
  deviceId: string;
  members?: string[];
  multiDeviceMode?: string;
}
interface SyncStatusRow {
  state: string;
  lastSyncAt?: string | null;
  members?: Array<{ deviceId: string; state: string; lastSyncAt?: string | null }>;
}

describe("replicated universe — two hosts per source", () => {
  let harness: SyntheticE2EHarness;
  let thingsHosts: readonly HarnessDevice[];
  let healthHosts: readonly HarnessDevice[];
  let thingsCount: number;

  const sourceRow = async (id: string): Promise<SourceRow | undefined> => {
    const { items } = await harness.gatewayJson<{ items: SourceRow[] }>("/admin/sources");
    return items.find((s) => s.id === id);
  };
  const status = (id: string) =>
    harness.gatewayJson<SyncStatusRow>(`/admin/sync/status/${encodeURIComponent(id)}`);
  /** The cursor row a host reads: its own row, or the shared one before it wrote. */
  const cursorAs = async (device: HarnessDevice, id: string) => {
    const res = await fetch(`${harness.gatewayUrl}/sync-state/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      cursor: unknown;
      lastSyncedAt: string | null;
      wipeEpoch: number;
    };
  };
  const healthRows = async (): Promise<number> => {
    const { rows } = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT COUNT(*) AS n FROM health_body" }),
    });
    return Number(rows[0]?.[0] ?? 0);
  };

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: UNIVERSE });
    await harness.start();
    thingsHosts = harness.devicesForSource(THINGS);
    healthHosts = harness.devicesForSource(HEALTH);
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("every host is a member; the owner is the roster's first host", async () => {
    expect(thingsHosts.map((d) => d.rosterId)).toEqual(["macbook", "imac"]);
    expect(healthHosts.map((d) => d.rosterId)).toEqual(["iphone", "ipad"]);
    for (const [id, hosts] of [
      [THINGS, thingsHosts],
      [HEALTH, healthHosts],
    ] as const) {
      const row = await sourceRow(id);
      expect(row?.multiDeviceMode).toBe("replicated");
      expect(row?.deviceId).toBe(hosts[0]!.deviceId);
      expect(row?.members).toEqual(hosts.map((d) => d.deviceId));
    }
  });

  test("every synthetic collector publishes its link declaration", async () => {
    const roles = await harness.gatewayJson<{ ready: boolean }>("/admin/url-graph-roles");
    expect(harness.getDevices().filter((device) => device.kind === "collector")).toHaveLength(2);
    expect(roles.ready).toBe(true);
  });

  test("two Macs contribute one replicated Apple corpus, including Call Log analytics", async () => {
    const sqlCount = async (table: string) => {
      const { rows } = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
        method: "POST",
        body: JSON.stringify({ sql: `SELECT COUNT(*) FROM ${table}` }),
      });
      return Number(rows[0]?.[0] ?? 0);
    };

    for (const id of APPLE_SOURCES) {
      const hosts = harness.devicesForSource(id);
      expect(hosts.map((host) => host.rosterId)).toEqual(["macbook", "imac"]);
      expect(await sourceRow(id)).toMatchObject({
        multiDeviceMode: "replicated",
        members: hosts.map((host) => host.deviceId),
      });

      await harness.triggerSyncAndWait(id, 60_000, hosts[0]);
      const oneReplica = await getDocumentCount(harness.gatewayUrl, harness.apiKey, id);
      expect(oneReplica).toBeGreaterThan(0);
      if (id.startsWith("apple-imessage:")) expect(oneReplica).toBe(4);
      await handOver(id, hosts[0]!);
      await harness.triggerSyncAndWait(id, 60_000, hosts[1]);
      expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, id)).toBe(oneReplica);
      for (const host of hosts) expect((await cursorAs(host, id)).lastSyncedAt).not.toBeNull();
    }

    expect(await sqlCount("apple_call_log")).toBe(4);

    for (const id of EXCLUSIVE_APPLE_SOURCES) {
      expect(harness.devicesForSource(id).map((host) => host.rosterId)).toEqual(["macbook"]);
      expect(await sourceRow(id)).toMatchObject({ multiDeviceMode: "exclusive" });
    }
  }, 300_000);

  test("two Macs keep Screen Time documents and analytics in independent streams", async () => {
    const hosts = harness.devicesForSource(SCREEN_TIME);
    expect(hosts.map((host) => host.rosterId)).toEqual(["macbook", "imac"]);
    expect(await sourceRow(SCREEN_TIME)).toMatchObject({
      multiDeviceMode: "partitioned",
      members: hosts.map((host) => host.deviceId),
    });
    const analyticsCount = async (table: string) => {
      const { rows } = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
        method: "POST",
        body: JSON.stringify({ sql: `SELECT COUNT(*) FROM ${table}` }),
      });
      return Number(rows[0]?.[0] ?? 0);
    };

    await harness.triggerSyncAndWait(SCREEN_TIME, 90_000, hosts[0]);
    const docsFromOne = await getDocumentCount(harness.gatewayUrl, harness.apiKey, SCREEN_TIME);
    const sessionsFromOne = await analyticsCount("screen_time_sessions");
    const dailyFromOne = await analyticsCount("screen_time_daily");
    expect(docsFromOne).toBe(3);
    expect(sessionsFromOne).toBeGreaterThan(0);
    expect(dailyFromOne).toBeGreaterThan(0);

    await harness.triggerSyncAndWait(SCREEN_TIME, 90_000, hosts[1]);
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SCREEN_TIME)).toBe(
      docsFromOne * 2,
    );
    const sessionsFromBoth = await analyticsCount("screen_time_sessions");
    expect(sessionsFromBoth).toBeGreaterThan(sessionsFromOne);
    expect(sessionsFromBoth - sessionsFromOne).not.toBe(sessionsFromOne);
    expect(await analyticsCount("screen_time_daily")).toBe(dailyFromOne * 2);
    expect(await analyticsCount("(SELECT DISTINCT _stream_id FROM screen_time_daily)")).toBe(2);
    expect(
      await analyticsCount(`(
        SELECT first.id
        FROM screen_time_daily first
        JOIN screen_time_daily second ON first.id = second.id
        WHERE first._stream_id <> second._stream_id
          AND first.total_seconds <> second.total_seconds
      )`),
    ).toBeGreaterThan(0);
  }, 240_000);

  test("Screen Time resync and detach remove only the selected Mac's documents and rows", async () => {
    const [first, second] = harness.devicesForSource(SCREEN_TIME) as [HarnessDevice, HarnessDevice];
    for (const host of [first, second]) {
      await harness.gatewayJson(`/admin/sources/${encodeURIComponent(SCREEN_TIME)}/resync`, {
        method: "POST",
        body: JSON.stringify({ deviceId: host.deviceId }),
      });
      await harness.triggerSyncAndWait(SCREEN_TIME, 90_000, host);
    }
    const db = new SqliteDatabase(harness.getDbPath(), { readonly: true });
    const documentsIn = (streamId: string) =>
      db
        .prepare<
          [string, string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM documents WHERE source_id = ? AND stream_id = ?")
        .get(SCREEN_TIME, streamId)!.n;
    const analyticsIn = async (table: string, streamId: string) => {
      const { rows } = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
        method: "POST",
        body: JSON.stringify({
          sql: `SELECT COUNT(*) FROM ${table} WHERE _stream_id = '${streamId}'`,
        }),
      });
      return Number(rows[0]?.[0] ?? 0);
    };
    try {
      const firstDocs = documentsIn(first.deviceId);
      const firstSessions = await analyticsIn("screen_time_sessions", first.deviceId);
      const firstDaily = await analyticsIn("screen_time_daily", first.deviceId);
      const secondSessions = await analyticsIn("screen_time_sessions", second.deviceId);
      const secondDaily = await analyticsIn("screen_time_daily", second.deviceId);
      expect(firstDocs).toBe(3);
      expect(secondSessions).not.toBe(firstSessions);

      expect(
        await harness.gatewayJson(`/admin/sources/${encodeURIComponent(SCREEN_TIME)}/resync`, {
          method: "POST",
          body: JSON.stringify({ deviceId: second.deviceId }),
        }),
      ).toEqual({
        ok: true,
        scope: "stream",
        deviceIds: [],
        restarting: [],
        disabled: [],
        skipped: [],
      });
      expect(documentsIn(second.deviceId)).toBe(0);
      expect(await analyticsIn("screen_time_sessions", second.deviceId)).toBe(0);
      expect(await analyticsIn("screen_time_daily", second.deviceId)).toBe(0);
      expect(documentsIn(first.deviceId)).toBe(firstDocs);

      await harness.triggerSyncAndWait(SCREEN_TIME, 90_000, second);
      expect(documentsIn(second.deviceId)).toBe(firstDocs);
      expect(await analyticsIn("screen_time_sessions", second.deviceId)).toBe(secondSessions);
      expect(await analyticsIn("screen_time_daily", second.deviceId)).toBe(secondDaily);

      const detached = await harness.gatewayJson<{ members: string[] }>(
        `/admin/sources/${encodeURIComponent(SCREEN_TIME)}/members/${second.deviceId}`,
        { method: "DELETE" },
      );
      expect(detached.members).toEqual([first.deviceId]);
      expect(documentsIn(second.deviceId)).toBe(0);
      expect(await analyticsIn("screen_time_sessions", second.deviceId)).toBe(0);
      expect(await analyticsIn("screen_time_daily", second.deviceId)).toBe(0);
      expect(documentsIn(first.deviceId)).toBe(firstDocs);
      expect(await analyticsIn("screen_time_sessions", first.deviceId)).toBe(firstSessions);
      expect(await analyticsIn("screen_time_daily", first.deviceId)).toBe(firstDaily);
    } finally {
      db.close();
    }
  }, 240_000);

  test("detaching an Apple replica preserves its shared documents and hybrid rows", async () => {
    for (const id of APPLE_SOURCES) {
      const [owner, member] = harness.devicesForSource(id) as [HarnessDevice, HarnessDevice];
      await harness.triggerSyncAndWait(id, 60_000, owner);
      await handOver(id, owner);
      await harness.triggerSyncAndWait(id, 60_000, member);
    }
    const callLogBefore = await getDocumentCount(
      harness.gatewayUrl,
      harness.apiKey,
      `apple-call-log:${APPLE_ACCOUNT}`,
    );
    const analyticsCount = async (table: string) => {
      const { rows } = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
        method: "POST",
        body: JSON.stringify({ sql: `SELECT COUNT(*) FROM ${table}` }),
      });
      return Number(rows[0]?.[0] ?? 0);
    };
    const callRows = await analyticsCount("apple_call_log");
    expect(callLogBefore).toBeGreaterThan(0);
    expect(callRows).toBeGreaterThan(0);

    for (const id of APPLE_SOURCES) {
      const [owner, member] = harness.devicesForSource(id) as [HarnessDevice, HarnessDevice];
      const detached = await harness.gatewayJson<{ members: string[] }>(
        `/admin/sources/${encodeURIComponent(id)}/members/${member.deviceId}`,
        { method: "DELETE" },
      );
      expect(detached.members).toEqual([owner.deviceId]);
    }

    expect(
      await getDocumentCount(harness.gatewayUrl, harness.apiKey, `apple-call-log:${APPLE_ACCOUNT}`),
    ).toBe(callLogBefore);
    expect(await analyticsCount("apple_call_log")).toBe(callRows);
  }, 180_000);

  /**
   * A replicated member syncing without the lease commits its documents but
   * leaves the snapshot reconcile to the holder. Releasing the holder's lease
   * before the other host's turn makes that host reconcile with authority,
   * so the "deletes nothing" invariant is checked on a reconciling host.
   */
  const handOver = async (id: string, holder: (typeof thingsHosts)[number]) => {
    await holder.gateway.releaseSyncLease(id as never);
  };

  test("both hosts sync the replica: one host's corpus, one cursor per host", async () => {
    // The owner alone yields the fixture set; the member's replica adds
    // nothing to it.
    await harness.triggerSyncAndWait(THINGS, 60_000, thingsHosts[0]);
    thingsCount = await getDocumentCount(harness.gatewayUrl, harness.apiKey, THINGS);
    expect(thingsCount).toBe(THINGS_FIXTURE_COUNT);
    await handOver(THINGS, thingsHosts[0]!);
    await harness.triggerSyncAndWait(THINGS, 60_000, thingsHosts[1]);
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, THINGS)).toBe(thingsCount);

    await harness.triggerSyncAndWait(HEALTH, 60_000, healthHosts[0]);
    const healthFromOnePhone = await healthRows();
    expect(healthFromOnePhone).toBeGreaterThan(0);
    await handOver(HEALTH, healthHosts[0]!);
    await harness.triggerSyncAndWait(HEALTH, 60_000, healthHosts[1]);
    expect(await healthRows()).toBe(healthFromOnePhone);

    // Each host synced on its own cursor row; the source reads as synced
    // with one member entry per host.
    for (const [id, hosts] of [
      [THINGS, thingsHosts],
      [HEALTH, healthHosts],
    ] as const) {
      // The status view reads a cache the gateway refreshes on a tick.
      await waitForCondition(
        async () => (await status(id)).state === "synced",
        30_000,
        `${id} reads as synced`,
      );
      const s = await status(id);
      expect(s.state).toBe("synced");
      expect(s.members?.map((m) => m.deviceId).sort()).toEqual(hosts.map((d) => d.deviceId).sort());
      for (const m of s.members ?? []) expect(m.state).toBe("synced");
      for (const host of hosts) {
        const { cursor, lastSyncedAt } = await cursorAs(host, id);
        expect(cursor).not.toBeNull();
        expect(lastSyncedAt).not.toBeNull();
      }
    }
  }, 180_000);

  test("a resync from either host reconciles against the same replica and deletes nothing", async () => {
    const before = {
      things: await getDocumentCount(harness.gatewayUrl, harness.apiKey, THINGS),
      health: await healthRows(),
    };
    const stamps = new Map<string, string>();
    for (const host of [...thingsHosts, ...healthHosts]) {
      const id = host.sourceIds.includes(THINGS) ? THINGS : HEALTH;
      stamps.set(host.rosterId, (await cursorAs(host, id)).lastSyncedAt!);
    }

    // Owner, member, owner again — nothing oscillates. Each turn hands the
    // lease over first, so every host reconciles with authority.
    let thingsHolder = thingsHosts[1]!;
    for (const host of [thingsHosts[0]!, thingsHosts[1]!, thingsHosts[0]!]) {
      await handOver(THINGS, thingsHolder);
      await harness.triggerSyncAndWait(THINGS, 60_000, host);
      thingsHolder = host;
      expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, THINGS)).toBe(
        before.things,
      );
    }
    let healthHolder = healthHosts[1]!;
    for (const host of [healthHosts[0]!, healthHosts[1]!]) {
      await handOver(HEALTH, healthHolder);
      await harness.triggerSyncAndWait(HEALTH, 60_000, host);
      healthHolder = host;
      expect(await healthRows()).toBe(before.health);
    }

    // Every host's cursor row only moved forward.
    for (const host of [...thingsHosts, ...healthHosts]) {
      const id = host.sourceIds.includes(THINGS) ? THINGS : HEALTH;
      const { lastSyncedAt } = await cursorAs(host, id);
      expect(lastSyncedAt! >= stamps.get(host.rosterId)!).toBe(true);
    }
  }, 180_000);

  test("an authoritative incomplete-view deletion makes a sibling bootstrap and restore the replica", async () => {
    const [holder, sibling] = thingsHosts as [HarnessDevice, HarnessDevice];
    expect(await holder.gateway.claimSyncLease?.(THINGS as never)).toMatchObject({
      granted: true,
    });
    const holderState = await cursorAs(holder, THINGS);
    const deleted = await fetch(`${harness.gatewayUrl}/documents/with-cursor`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${holder.token}`,
      },
      body: JSON.stringify({
        providerId: THINGS,
        sourceId: THINGS,
        documents: [],
        deletedExternalIds: ["synth-things-001"],
        cursor: holderState.cursor,
        hasMore: false,
        wipeEpoch: holderState.wipeEpoch,
      }),
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ tombstonedDeleted: 1 });
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, THINGS)).toBe(
      thingsCount - 1,
    );
    expect((await cursorAs(sibling, THINGS)).lastSyncedAt).toBeNull();

    // The sibling does not hold deletion authority, but its invalidated cursor
    // makes the real provider run a bootstrap and re-contribute the full store.
    await harness.triggerSyncAndWait(THINGS, 60_000, sibling);
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, THINGS)).toBe(thingsCount);
    expect((await cursorAs(sibling, THINGS)).lastSyncedAt).not.toBeNull();
  }, 120_000);

  test("a member detaching loses no data; the owner detaching hands the source on; the last host cannot detach", async () => {
    const [owner, member] = thingsHosts as [HarnessDevice, HarnessDevice];
    const detached = await harness.gatewayJson<{ members: string[]; source: SourceRow }>(
      `/admin/sources/${encodeURIComponent(THINGS)}/members/${member.deviceId}`,
      { method: "DELETE" },
    );
    expect(detached.members).toEqual([owner.deviceId]);
    expect(detached.source.deviceId).toBe(owner.deviceId);
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, THINGS)).toBe(thingsCount);
    // The detached host leaves the status breakdown with its cursor row.
    await waitForCondition(
      async () => (await status(THINGS)).members === undefined,
      30_000,
      "the detached host left the status breakdown",
    );
    expect((await status(THINGS)).state).toBe("synced");

    // The member rejoins by registering the source again, then the owner leaves.
    const rejoined = await member.gateway.bulkUpsertSources([
      {
        type: THINGS.slice(0, THINGS.indexOf(":")),
        accountId: THINGS.slice(THINGS.indexOf(":") + 1),
        enabled: true,
      } as never,
    ]);
    expect(rejoined.errors).toEqual([]);
    expect((await sourceRow(THINGS))?.members).toEqual([owner.deviceId, member.deviceId]);
    const handedOver = await harness.gatewayJson<{ members: string[]; source: SourceRow }>(
      `/admin/sources/${encodeURIComponent(THINGS)}/members/${owner.deviceId}`,
      { method: "DELETE" },
    );
    expect(handedOver.members).toEqual([member.deviceId]);
    expect(handedOver.source.deviceId).toBe(member.deviceId);
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, THINGS)).toBe(thingsCount);

    // The last host is refused: removing the source is a separate act.
    const last = await harness.gatewayFetch(
      `/admin/sources/${encodeURIComponent(THINGS)}/members/${member.deviceId}`,
      { method: "DELETE" },
    );
    expect(last.status).toBe(409);
    expect(((await last.json()) as { code: string }).code).toBe("LAST_MEMBER");
  }, 180_000);

  test("a revoked phone stays a dormant member; forgetting it needs a detach first; the other phone keeps the data", async () => {
    const [owner, member] = healthHosts as [HarnessDevice, HarnessDevice];
    const rows = await healthRows();
    const revoked = await harness.gatewayFetch(`/admin/devices/${member.deviceId}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    // Membership survives revocation, so a re-pair of the same phone finds
    // the source still attached; its data is untouched.
    expect((await sourceRow(HEALTH))?.members).toEqual([owner.deviceId, member.deviceId]);
    expect(await healthRows()).toBe(rows);
    await harness.triggerSyncAndWait(HEALTH, 60_000, owner);
    await waitForCondition(
      async () => (await status(HEALTH)).state === "synced",
      30_000,
      "the remaining phone reads as synced",
    );

    // Forgetting the phone is refused while it hosts the source.
    const forget = await harness.gatewayFetch(`/admin/devices/${member.deviceId}?forget=true`, {
      method: "DELETE",
    });
    expect(forget.status).toBe(409);
    expect(((await forget.json()) as { code: string }).code).toBe("DEVICE_STILL_HOSTS_SOURCES");

    // Detaching it first releases the membership; the owner keeps everything.
    const detached = await harness.gatewayJson<{ members: string[] }>(
      `/admin/sources/${encodeURIComponent(HEALTH)}/members/${member.deviceId}`,
      { method: "DELETE" },
    );
    expect(detached.members).toEqual([owner.deviceId]);
    const forgotten = await harness.gatewayFetch(`/admin/devices/${member.deviceId}?forget=true`, {
      method: "DELETE",
    });
    expect(forgotten.status).toBe(200);
    expect((await sourceRow(HEALTH))?.deviceId).toBe(owner.deviceId);
    expect(await healthRows()).toBe(rows);
  }, 180_000);
});
