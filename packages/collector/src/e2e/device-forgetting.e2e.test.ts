// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Forgetting a collector retires its contribution, independently of live siblings. */
import "./synth-env.js";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness, type HarnessDevice } from "./synth-harness.js";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

const TYPES = {
  exclusive: "retirement-exclusive-synth",
  replica: "retirement-replica-synth",
  handoff: "retirement-handoff-synth",
  partition: "retirement-activity-synth",
  solo: "retirement-solo-synth",
} as const;
const MODES = {
  [TYPES.replica]: "replicated" as const,
  [TYPES.handoff]: "handoff" as const,
  [TYPES.partition]: "partitioned" as const,
  [TYPES.solo]: "partitioned" as const,
};

interface SourceRow {
  id: string;
  deviceId: string;
  enabled: boolean;
  archived?: boolean;
  members: string[];
}
interface MemberStatus {
  deviceId?: string;
  state: string;
  errorMessage?: string;
  remediation?: { summary: string };
  notices?: Array<{ severity: string }>;
}
interface SourceStatus extends MemberStatus {
  sourceId: string;
  members?: MemberStatus[];
}
interface ForgetImpact {
  fingerprint: string;
  sources: Array<{
    id: string;
    otherDeviceCount: number;
    deleteScope: "source" | "partition" | "none";
  }>;
}
interface Scenario {
  label: "keep" | "delete";
  retiring: PairedCollector;
  sibling: PairedCollector;
  ids: Record<keyof typeof TYPES, string>;
  futureWritten?: boolean;
}

async function asDevice<T>(
  collector: PairedCollector,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${collector.gatewayBase}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${collector.token}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

describe("forgetting a device and its source contributions", () => {
  let harness: MultiCollectorHarness;
  const scenarios: Scenario[] = [];

  const sources = async () => (await harness.json<{ items: SourceRow[] }>("/admin/sources")).items;
  const source = async (id: string) => (await sources()).find((row) => row.id === id);
  const count = async (id: string) =>
    (await harness.json<{ count: number }>(`/documents/count/${encodeURIComponent(id)}`)).count;
  const recent = async (id: string) =>
    (
      await harness.json<{ documents: Array<{ deviceId: string | null; contentPreview: string }> }>(
        `/documents/recent/${encodeURIComponent(id)}`,
      )
    ).documents;
  const status = (id: string) =>
    harness.json<SourceStatus>(`/admin/sync/status/${encodeURIComponent(id)}`);
  const impact = (collector: PairedCollector) =>
    harness.json<ForgetImpact>(`/admin/devices/${collector.deviceId}/forget-impact`);
  const forget = async (
    collector: PairedCollector,
    data: "keep" | "delete",
    fingerprint: string,
  ) => {
    const result = await harness.json<{ forgotten: boolean }>(
      `/admin/devices/${collector.deviceId}?forget=true&data=${data}&impactFingerprint=${fingerprint}`,
      { method: "DELETE" },
    );
    collector.ws.disconnect();
    return result;
  };
  const table = (scenario: Scenario, kind: "partition" | "solo") =>
    `retirement_${scenario.label}_${kind}`;
  const analyticsCounts = async (scenario: Scenario, kind: "partition" | "solo") => {
    const { rows } = await harness.json<{ rows: unknown[][] }>("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({
        sql: `SELECT _stream_id, COUNT(*) FROM ${table(scenario, kind)} GROUP BY _stream_id ORDER BY _stream_id`,
      }),
    });
    return new Map(rows.map(([id, amount]) => [String(id), Number(amount)]));
  };

  async function register(collector: PairedCollector, types: string[], accountId: string) {
    const result = await asDevice<{ errors: unknown[] }>(
      collector,
      "/devices/sources/bulk-upsert",
      {
        method: "POST",
        body: JSON.stringify({
          sources: types.map((type) => ({ type, accountId, enabled: true })),
        }),
      },
    );
    expect(result.errors).toEqual([]);
  }

  async function ingestAnalytics(
    scenario: Scenario,
    kind: "partition" | "solo",
    collector: PairedCollector,
    recordId = "counter",
  ) {
    const sourceId = scenario.ids[kind];
    const { wipeEpoch } = await asDevice<{ wipeEpoch: number }>(
      collector,
      `/sync-state/${encodeURIComponent(sourceId)}/begin`,
      { method: "POST", body: JSON.stringify({ attemptId: randomUUID() }) },
    );
    expect(
      await asDevice<{ ingested: number }>(collector, "/analytics/ingest", {
        method: "POST",
        body: JSON.stringify({
          sourceId,
          tableName: table(scenario, kind),
          schema: {
            tableName: table(scenario, kind),
            displayName: "Fictional activity counters",
            description: "Invented per-device counters for retirement coverage",
            columns: [
              { name: "id", type: "VARCHAR", description: "Counter id" },
              { name: "value", type: "INTEGER", description: "Counter value" },
            ],
            primaryKey: ["id"],
          },
          records: [{ id: recordId, value: 1 }],
          writeEpoch: wipeEpoch,
        }),
      }),
    ).toMatchObject({ ingested: 1 });
  }

  async function seed(label: Scenario["label"]): Promise<Scenario> {
    const retiring = await harness.addCollector({
      name: `retiring-${label}`,
      hostableSourceTypes: Object.values(TYPES),
      multiDeviceModes: MODES,
      syncLease: true,
    });
    const sibling = await harness.addCollector({
      name: `continuing-${label}`,
      hostableSourceTypes: [TYPES.replica, TYPES.handoff, TYPES.partition],
      multiDeviceModes: MODES,
      syncLease: true,
    });
    const accountId = `${label}@example.com`;
    const ids = Object.fromEntries(
      Object.entries(TYPES).map(([kind, type]) => [kind, `${type}:${accountId}`]),
    ) as Scenario["ids"];
    const scenario = { label, retiring, sibling, ids };
    await register(retiring, Object.values(TYPES), accountId);
    await register(sibling, [TYPES.replica, TYPES.handoff, TYPES.partition], accountId);
    await harness.pushDocuments(
      retiring,
      Object.values(ids).map((sourceId) => ({
        sourceId,
        externalId: "record",
        title: "Fictional saved history",
        content: "A made-up workshop checklist.",
      })),
    );
    await harness.pushDocuments(sibling, [
      { sourceId: ids.replica, externalId: "record", content: "A made-up workshop checklist." },
      {
        sourceId: ids.partition,
        externalId: "record",
        content: "A separate invented daily summary.",
      },
    ]);
    await ingestAnalytics(scenario, "partition", retiring);
    await ingestAnalytics(scenario, "partition", sibling);
    await ingestAnalytics(scenario, "solo", retiring);
    for (const sourceId of Object.values(ids)) {
      retiring.ws.emitEvent("sync.status", {
        sourceId,
        deviceId: retiring.deviceId,
        state: "error",
        errorMessage: "A fictional retired device can no longer read its store.",
        remediation: {
          summary: "Access is required",
          steps: ["Restore access on the fictional device."],
          restartRequired: false,
        },
      });
    }
    for (const sourceId of [ids.replica, ids.handoff, ids.partition]) {
      sibling.ws.emitEvent("sync.status", {
        sourceId,
        deviceId: sibling.deviceId,
        state: "idle",
      });
    }
    await waitForCondition(
      async () => {
        const row = await status(ids.partition);
        return (
          row.members?.some(
            (member) => member.deviceId === retiring.deviceId && member.state === "error",
          ) === true
        );
      },
      10_000,
      "the retiring contribution's error reached the gateway",
    );
    expect(await count(ids.partition)).toBe(2);
    expect(await analyticsCounts(scenario, "partition")).toEqual(
      new Map([
        [retiring.deviceId, 1],
        [sibling.deviceId, 1],
      ]),
    );
    return scenario;
  }

  async function writeFuture(scenario: Scenario) {
    for (const kind of ["replica", "handoff", "partition"] as const) {
      if (kind !== "partition") {
        expect(
          await asDevice(
            scenario.sibling,
            `/sync-state/${encodeURIComponent(scenario.ids[kind])}/lease`,
            { method: "POST", body: "{}" },
          ),
        ).toMatchObject({ granted: true });
      }
      const sourceId = scenario.ids[kind];
      const { wipeEpoch } = await asDevice<{ wipeEpoch: number }>(
        scenario.sibling,
        `/sync-state/${encodeURIComponent(sourceId)}/begin`,
        { method: "POST", body: JSON.stringify({ attemptId: randomUUID() }) },
      );
      const content = `A newly created fictional ${kind} workshop schedule after retirement.`;
      const stamp = new Date().toISOString();
      const push = (epoch: number) =>
        asDevice<{
          ingested: number;
          rejectedSourceIds?: string[];
        }>(scenario.sibling, "/documents", {
          method: "POST",
          body: JSON.stringify({
            documents: [
              {
                providerId: sourceId,
                sourceId,
                externalId: `future-${kind}`,
                title: `New ${kind} workshop schedule`,
                content,
                contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
                metadata: {},
                sourceCreatedAt: stamp,
                sourceUpdatedAt: stamp,
              },
            ],
            writeEpochs: { [sourceId]: epoch },
          }),
        });
      const context = `${scenario.label}/${kind}, current write epoch ${wipeEpoch}`;
      if (kind === "handoff") {
        expect(wipeEpoch, context).toBeGreaterThan(0);
        const before = await count(sourceId);
        const stale = await push(wipeEpoch - 1);
        expect(stale, context).toMatchObject({ ingested: 0, rejectedSourceIds: [sourceId] });
        expect(await count(sourceId), `${context}: stale page changed history`).toBe(before);
      }
      const receipt = await push(wipeEpoch);
      expect(receipt, context).toMatchObject({ ingested: 1 });
      expect(receipt.rejectedSourceIds ?? [], context).toEqual([]);
      expect(await count(sourceId), context).toBe(
        kind === "partition" && scenario.label === "keep" ? 3 : 2,
      );
      expect(await recent(scenario.ids[kind])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            deviceId: kind === "partition" ? scenario.sibling.deviceId : null,
            contentPreview: content,
          }),
        ]),
      );
    }
    await ingestAnalytics(scenario, "partition", scenario.sibling, "future-counter");
    scenario.futureWritten = true;
    expect(await analyticsCounts(scenario, "partition")).toEqual(
      new Map([
        ...(scenario.label === "keep" ? [[scenario.retiring.deviceId, 1] as const] : []),
        [scenario.sibling.deviceId, 2],
      ]),
    );
  }

  async function expectHealthyHistory(scenario: Scenario) {
    const rows = await sources();
    for (const id of Object.values(scenario.ids)) {
      const row = rows.find((item) => item.id === id);
      expect(row).toBeDefined();
      expect(row?.members).not.toContain(scenario.retiring.deviceId);
      const display = await status(id);
      expect(display.state).not.toBe("error");
      expect(display.errorMessage).toBeUndefined();
      expect(display.remediation).toBeUndefined();
      expect(display.notices?.some((notice) => notice.severity === "error")).not.toBe(true);
      expect(
        display.members?.some((member) => member.deviceId === scenario.retiring.deviceId),
      ).not.toBe(true);
    }
    expect((await source(scenario.ids.exclusive))?.enabled).toBe(false);
    expect((await source(scenario.ids.solo))?.enabled).toBe(false);
    for (const kind of ["replica", "handoff", "partition"] as const) {
      expect((await source(scenario.ids[kind]))?.deviceId).toBe(scenario.sibling.deviceId);
      expect((await source(scenario.ids[kind]))?.members).toEqual([scenario.sibling.deviceId]);
    }
    for (const kind of ["exclusive", "replica", "handoff", "solo"] as const) {
      expect(await count(scenario.ids[kind])).toBe(
        scenario.futureWritten && (kind === "replica" || kind === "handoff") ? 2 : 1,
      );
    }
    expect(await count(scenario.ids.partition)).toBe(scenario.futureWritten ? 3 : 2);
    expect(await recent(scenario.ids.partition)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: scenario.retiring.deviceId,
          contentPreview: "A made-up workshop checklist.",
        }),
        expect.objectContaining({
          deviceId: scenario.sibling.deviceId,
          contentPreview: "A separate invented daily summary.",
        }),
      ]),
    );
    expect(await analyticsCounts(scenario, "partition")).toEqual(
      new Map([
        [scenario.retiring.deviceId, 1],
        [scenario.sibling.deviceId, scenario.futureWritten ? 2 : 1],
      ]),
    );
    expect(await analyticsCounts(scenario, "solo")).toEqual(
      new Map([[scenario.retiring.deviceId, 1]]),
    );
  }

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 20_000);

  test("forgetting an empty device needs no data decision and leaves sources untouched", async () => {
    const before = await sources();
    const empty = await harness.addCollector({
      name: "fictional-empty-device",
      hostableSourceTypes: [],
    });
    expect(
      await harness.json(`/admin/devices/${empty.deviceId}?forget=true`, { method: "DELETE" }),
    ).toMatchObject({ forgotten: true });
    empty.ws.disconnect();
    harness.collectors = harness.collectors.filter((collector) => collector !== empty);
    expect(
      (await harness.json<{ items: Array<{ id: string }> }>("/admin/devices")).items.some(
        (row) => row.id === empty.deviceId,
      ),
    ).toBe(false);
    expect(
      await fetch(`${empty.gatewayBase}/documents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${empty.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ documents: [] }),
      }).then((response) => response.status),
    ).toBe(401);
    expect(await sources()).toEqual(before);
  });

  test("keeping historical data retires errors without changing any stored contribution", async () => {
    const scenario = await seed("keep");
    scenarios.push(scenario);
    const preview = await impact(scenario.retiring);
    expect(preview.sources.map((item) => item.id).sort()).toEqual(
      Object.values(scenario.ids).sort(),
    );
    for (const kind of ["replica", "handoff"] as const) {
      expect(preview.sources.find((item) => item.id === scenario.ids[kind])).toMatchObject({
        otherDeviceCount: 1,
        deleteScope: "none",
      });
    }
    expect(preview.sources.find((item) => item.id === scenario.ids.partition)).toMatchObject({
      otherDeviceCount: 1,
      deleteScope: "partition",
    });
    for (const kind of ["exclusive", "solo"] as const) {
      expect(preview.sources.find((item) => item.id === scenario.ids[kind])).toMatchObject({
        otherDeviceCount: 0,
        deleteScope: "source",
      });
    }
    // A new source changes the consequences after the user reviewed them.
    // The stale confirmation must not partially retire any existing source.
    await register(scenario.retiring, [TYPES.exclusive], "keep-extra@example.com");
    await expect(forget(scenario.retiring, "keep", preview.fingerprint)).rejects.toMatchObject({
      status: 409,
    });
    expect((await source(scenario.ids.partition))?.members).toContain(scenario.retiring.deviceId);
    expect(await count(scenario.ids.partition)).toBe(2);
    const refreshedPreview = await impact(scenario.retiring);
    expect(refreshedPreview.fingerprint).not.toBe(preview.fingerprint);
    expect(await forget(scenario.retiring, "keep", refreshedPreview.fingerprint)).toMatchObject({
      forgotten: true,
    });
    harness.collectors = harness.collectors.filter((collector) => collector !== scenario.retiring);
    await expectHealthyHistory(scenario);
    const { items } = await harness.json<{ items: Array<{ id: string }> }>("/admin/devices");
    expect(items.some((item) => item.id === scenario.retiring.deviceId)).toBe(false);

    const rejectedWrite = await fetch(`${harness.gatewayUrl}/documents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${scenario.retiring.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ documents: [] }),
    });
    expect(rejectedWrite.status).toBe(401);
    await expect(
      harness.json("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({ kind: "collector", repairDeviceId: scenario.retiring.deviceId }),
      }),
    ).rejects.toMatchObject({ status: 404 });
    const replacement = await harness.addCollector({
      name: scenario.retiring.name,
      hostableSourceTypes: Object.values(TYPES),
      multiDeviceModes: MODES,
      syncLease: true,
    });
    expect(replacement.deviceId).not.toBe(scenario.retiring.deviceId);
    for (const id of Object.values(scenario.ids)) {
      expect((await source(id))?.members).not.toContain(replacement.deviceId);
    }
    await expectHealthyHistory(scenario);
    await writeFuture(scenario);
    await expectHealthyHistory(scenario);
  }, 120_000);

  test("deleting removes only this device's partitions and sole-host sources", async () => {
    const scenario = await seed("delete");
    scenarios.push(scenario);
    const preview = await impact(scenario.retiring);
    expect(await forget(scenario.retiring, "delete", preview.fingerprint)).toMatchObject({
      forgotten: true,
    });
    harness.collectors = harness.collectors.filter((collector) => collector !== scenario.retiring);
    await waitForCondition(
      async () =>
        (await count(scenario.ids.exclusive)) === 0 &&
        (await count(scenario.ids.solo)) === 0 &&
        (await count(scenario.ids.partition)) === 1 &&
        (await analyticsCounts(scenario, "partition")).get(scenario.retiring.deviceId) ===
          undefined,
      60_000,
      "only the forgotten device's data was removed",
    );
    for (const kind of ["replica", "handoff", "partition"] as const) {
      expect((await source(scenario.ids[kind]))?.members).toEqual([scenario.sibling.deviceId]);
      expect(await count(scenario.ids[kind])).toBe(1);
      const display = await status(scenario.ids[kind]);
      expect(display.state).not.toBe("error");
      expect(
        display.members?.some((member) => member.deviceId === scenario.retiring.deviceId),
      ).not.toBe(true);
    }
    expect(await recent(scenario.ids.partition)).toEqual([
      expect.objectContaining({
        deviceId: scenario.sibling.deviceId,
        contentPreview: "A separate invented daily summary.",
      }),
    ]);
    expect(await analyticsCounts(scenario, "partition")).toEqual(
      new Map([[scenario.sibling.deviceId, 1]]),
    );
    await writeFuture(scenario);
  }, 120_000);

  test("retirement survives a gateway restart without resurrecting errors or deleting retained history", async () => {
    await harness.restartGateway();
    await expectHealthyHistory(scenarios.find((scenario) => scenario.label === "keep")!);
    const removed = scenarios.find((scenario) => scenario.label === "delete")!;
    expect(await count(removed.ids.partition)).toBe(2);
    expect(await analyticsCounts(removed, "partition")).toEqual(
      new Map([[removed.sibling.deviceId, 2]]),
    );
    const { items } = await harness.json<{ items: Array<{ id: string }> }>("/admin/devices");
    for (const scenario of scenarios) {
      expect(items.some((item) => item.id === scenario.retiring.deviceId)).toBe(false);
    }
  }, 120_000);
  test("deleting the last active member preserves an earlier forgotten device's archived history", async () => {
    const scenario = scenarios.find((item) => item.label === "keep")!;
    const preview = await impact(scenario.sibling);
    for (const kind of ["replica", "handoff"] as const) {
      expect(preview.sources.find((item) => item.id === scenario.ids[kind])).toMatchObject({
        otherDeviceCount: 0,
        deleteScope: "none",
      });
    }
    expect(preview.sources.find((item) => item.id === scenario.ids.partition)).toMatchObject({
      otherDeviceCount: 0,
      deleteScope: "partition",
    });
    expect(await forget(scenario.sibling, "delete", preview.fingerprint)).toMatchObject({
      forgotten: true,
    });
    harness.collectors = harness.collectors.filter((collector) => collector !== scenario.sibling);
    await waitForCondition(
      async () =>
        (await count(scenario.ids.partition)) === 1 &&
        (await analyticsCounts(scenario, "partition")).get(scenario.sibling.deviceId) === undefined,
      60_000,
      "the last active member's own partition was removed, leaving archived history",
    );
    for (const kind of ["replica", "handoff", "partition"] as const) {
      expect(await count(scenario.ids[kind])).toBe(kind === "partition" ? 1 : 2);
      expect(await source(scenario.ids[kind])).toMatchObject({
        archived: true,
        enabled: false,
        members: [],
      });
      const display = await status(scenario.ids[kind]);
      expect(display.state).not.toBe("error");
      expect(display.notices?.some((notice) => notice.severity === "error")).not.toBe(true);
    }
    expect(await recent(scenario.ids.partition)).toEqual([
      expect.objectContaining({
        deviceId: scenario.retiring.deviceId,
        contentPreview: "A made-up workshop checklist.",
      }),
    ]);
    expect(await analyticsCounts(scenario, "partition")).toEqual(
      new Map([[scenario.retiring.deviceId, 1]]),
    );
    await harness.restartGateway();
    expect(await count(scenario.ids.partition)).toBe(1);
    expect((await status(scenario.ids.partition)).state).not.toBe("error");
  }, 120_000);
});

interface SyncedHistoryDocument {
  id: string;
  deviceId: string;
  deviceName: string;
  title: string;
  contentPreview: string;
}

// These companions use the production SyncEngine and source normalizers over
// the existing invented universe, rather than the pseudo-collector write seam.
describe.each(["keep", "delete"] as const)("forget %s after real collector syncing", (data) => {
  const activity = "screen-time:john.smith@icloud.example";
  const shared = "things:local";
  let harness: SyntheticE2EHarness;
  let retiring: HarnessDevice;
  let sibling: HarnessDevice;
  const restoreFixtures: Array<() => void> = [];

  const source = async () =>
    (await harness.gatewayJson<{ items: SourceRow[] }>("/admin/sources")).items.find(
      (row) => row.id === activity,
    );
  const display = () =>
    harness.gatewayJson<SourceStatus>(`/admin/sync/status/${encodeURIComponent(activity)}`);
  const history = async () => {
    const { documents } = await harness.gatewayJson<{ documents: SyncedHistoryDocument[] }>(
      `/documents/recent/${encodeURIComponent(activity)}?limit=100`,
    );
    const analytics: unknown[][][] = [];
    for (const table of ["screen_time_daily", "screen_time_sessions"]) {
      const { rows } = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
        method: "POST",
        body: JSON.stringify({
          sql:
            table === "screen_time_daily"
              ? `SELECT _stream_id, id, total_seconds FROM ${table} ORDER BY _stream_id, id`
              : `SELECT _stream_id, COUNT(*) FROM ${table} GROUP BY _stream_id ORDER BY _stream_id`,
        }),
      });
      analytics.push(rows);
    }
    return { documents: documents.sort((a, b) => a.id.localeCompare(b.id)), analytics };
  };

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "replicated",
      agentBackend: "off",
      embedderBackend: "off",
    });
    await harness.start();
    [sibling, retiring] = harness.devicesForSource(activity) as [HarnessDevice, HarnessDevice];
    expect([sibling.kind, retiring.kind]).toEqual(["collector", "collector"]);
  }, 120_000);

  afterAll(async () => {
    try {
      await harness.stopSyncLoopsAndDrain();
    } finally {
      try {
        await harness.destroy();
      } finally {
        for (const restore of restoreFixtures) restore();
      }
    }
  }, 60_000);

  test("retirement preserves the chosen history while the other collector still ingests normally", async () => {
    for (const device of [sibling, retiring]) {
      for (const id of [activity, shared]) {
        await harness.triggerSyncAndWait(id, 90_000, device);
        expect(device.engine.getStatuses().find((status) => status.sourceId === id)).toMatchObject({
          state: "idle",
        });
      }
    }
    const before = await history();
    for (const device of [sibling, retiring]) {
      expect(
        before.documents.filter((document) => document.deviceId === device.deviceId).length,
      ).toBeGreaterThan(0);
      expect(before.analytics.every((rows) => rows.some(([id]) => id === device.deviceId))).toBe(
        true,
      );
    }
    const retiredExample = before.documents.find(
      (document) => document.deviceId === retiring.deviceId,
    )!;
    const searchPath = `/documents/search?q=${encodeURIComponent(retiredExample.contentPreview)}&sources=${encodeURIComponent(activity)}&limit=100`;
    const searchIds = async () =>
      (await harness.gatewayJson<{ results: Array<{ id: string }> }>(searchPath)).results.map(
        (row) => row.id,
      );
    expect(await searchIds()).toContain(retiredExample.id);
    let sharedBefore = await harness.gatewayJson<{ count: number }>(`/documents/count/${shared}`);
    expect(sharedBefore.count).toBeGreaterThan(0);

    expect((await retiring.engine.stopSyncLoopAndDrain()).timedOut).toBe(false);
    retiring.ws?.disconnect();
    await harness.gatewayJson(`/admin/devices/${retiring.deviceId}`, { method: "DELETE" });
    expect(
      (await display()).members?.find((member) => member.deviceId === retiring.deviceId),
    ).toMatchObject({
      state: "error",
      remediation: { summary: "This device needs to be paired again" },
    });
    const impact = await harness.gatewayJson<ForgetImpact>(
      `/admin/devices/${retiring.deviceId}/forget-impact`,
    );
    expect(impact.sources.find((row) => row.id === activity)?.deleteScope).toBe("partition");
    expect(
      await harness.gatewayJson(
        `/admin/devices/${retiring.deviceId}?forget=true&data=${data}&impactFingerprint=${impact.fingerprint}`,
        { method: "DELETE" },
      ),
    ).toMatchObject({ forgotten: true });

    let expected = {
      documents: before.documents.filter(
        (document) => data === "keep" || document.deviceId !== retiring.deviceId,
      ),
      analytics: before.analytics.map((rows) =>
        rows.filter(([id]) => data === "keep" || id !== retiring.deviceId),
      ),
    };
    await waitForCondition(
      async () => {
        const current = await history();
        return JSON.stringify(current) === JSON.stringify(expected);
      },
      60_000,
      "the real collector's chosen retained or removed partition settled",
    );
    const assertRetired = async () => {
      expect(await history()).toEqual(expected);
      const devices = await harness.gatewayJson<{ items: Array<{ id: string }> }>("/admin/devices");
      expect(devices.items.some((device) => device.id === retiring.deviceId)).toBe(false);
      expect((await source())?.members).toEqual([sibling.deviceId]);
      const status = await display();
      expect(status.state).not.toBe("error");
      expect(status.members?.some((member) => member.deviceId === retiring.deviceId)).not.toBe(
        true,
      );
      expect(status.notices?.some((notice) => notice.severity === "error")).not.toBe(true);
      if (data === "keep")
        expect(
          (await history()).documents
            .filter((document) => document.deviceId === retiring.deviceId)
            .every((document) => document.deviceName === retiring.name),
        ).toBe(true);
      expect((await searchIds()).includes(retiredExample.id)).toBe(data === "keep");
      expect(await harness.gatewayJson(`/documents/count/${shared}`)).toEqual(sharedBefore);
    };
    await assertRetired();

    // Append genuinely new provider input after retirement, without changing
    // tracked fixtures. The surviving SyncEngine must normalize and push it.
    const { loadTasks } = await import("@omnesis/provider-things-synth/src/fixtures.js");
    const { allSessions } = await import("@omnesis/provider-screen-time-synth/src/fixtures.js");
    const tasks = loadTasks();
    const sessions = allSessions(
      String(sibling.sourceConfigs[activity].params?.__syntheticDeviceId ?? ""),
    );
    const taskLength = tasks.length;
    const sessionLength = sessions.length;
    restoreFixtures.push(() => {
      tasks.length = taskLength;
      sessions.length = sessionLength;
    });
    const nextDay = new Date(Math.max(...sessions.map((row) => Date.parse(row.date))) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const marker = `Retirement workshop ${data}`;
    const bundle = `com.example.retirement.${data}`;
    tasks.push({
      externalId: `future-workshop-${data}`,
      title: marker,
      notes: "Prepare a newly scheduled fictional workshop.",
      createdAt: `${nextDay}T09:00:00.000Z`,
      modifiedAt: `${nextDay}T09:00:00.000Z`,
      deadline: null,
      project: "Invented workshops",
      tags: [],
      status: "open",
    });
    sessions.push({
      id: `future-session-${data}`,
      bundle_id: bundle,
      app_name: marker,
      start_time: `${nextDay}T09:00:00.000Z`,
      end_time: `${nextDay}T09:10:00.000Z`,
      duration_seconds: 600,
      date: nextDay,
      day_of_week: new Date(nextDay).getUTCDay(),
    });
    // This partitioned source completes a finite snapshot; reopen only the survivor's
    // cursor so its next real tick discovers the newly appended day.
    const path = `/sync-state/${encodeURIComponent(activity)}`;
    const headers = {
      Authorization: `Bearer ${sibling.token}`,
      "Content-Type": "application/json",
    };
    const stateResponse = await fetch(`${harness.gatewayUrl}${path}`, { headers });
    expect(stateResponse.status).toBe(200);
    const { wipeEpoch } = (await stateResponse.json()) as { wipeEpoch: number };
    const reset = await fetch(`${harness.gatewayUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cursor: {}, writeEpoch: wipeEpoch }),
    });
    expect(reset.status).toBe(200);
    for (const id of [shared, activity]) {
      await harness.triggerSyncAndWait(id, 90_000, sibling);
      expect(sibling.engine.getStatuses().find((status) => status.sourceId === id)).toMatchObject({
        state: "idle",
      });
    }
    const current = await history();
    const newDocuments = current.documents.filter(
      (document) => !expected.documents.some((old) => old.id === document.id),
    );
    expect(newDocuments).toHaveLength(1);
    expect(newDocuments[0]).toMatchObject({
      deviceId: sibling.deviceId,
      title: expect.stringContaining(nextDay),
    });
    expect(newDocuments[0].contentPreview).toContain(marker);
    const analytics = expected.analytics.map((rows) => rows.map((row) => [...row]));
    analytics[0].push([sibling.deviceId, `${bundle}:${nextDay}`, 600]);
    const binaryOrder = (a: unknown, b: unknown) =>
      String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    analytics[0].sort((a, b) => binaryOrder(a[0], b[0]) || binaryOrder(a[1], b[1]));
    analytics[1] = analytics[1].map(([id, amount]) => [
      id,
      Number(amount) + (id === sibling.deviceId ? 1 : 0),
    ]);
    expected = {
      documents: [...expected.documents, ...newDocuments].sort((a, b) => a.id.localeCompare(b.id)),
      analytics,
    };
    sharedBefore = { count: sharedBefore.count + 1 };
    const assertNewSearch = async () => {
      for (const id of [activity, shared]) {
        const results = await harness.gatewayJson<{ results: Array<{ id: string }> }>(
          `/documents/search?q=${encodeURIComponent(marker)}&sources=${encodeURIComponent(id)}&limit=100`,
        );
        expect(results.results.length).toBeGreaterThan(0);
        if (id === activity)
          expect(results.results.map((row) => row.id)).toContain(newDocuments[0].id);
      }
    };
    await assertRetired();
    await assertNewSearch();
    await harness.restartGateway();
    await assertRetired();
    await assertNewSearch();
  }, 240_000);
});
