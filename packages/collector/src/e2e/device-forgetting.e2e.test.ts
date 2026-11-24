// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Forgetting a collector retires its contribution, independently of live siblings. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
          records: [{ id: "counter", value: 1 }],
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
      expect(await count(scenario.ids[kind])).toBe(1);
    }
    expect(await count(scenario.ids.partition)).toBe(2);
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
        [scenario.sibling.deviceId, 1],
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
  }, 120_000);

  test("retirement survives a gateway restart without resurrecting errors or deleting retained history", async () => {
    await harness.restartGateway();
    await expectHealthyHistory(scenarios.find((scenario) => scenario.label === "keep")!);
    const removed = scenarios.find((scenario) => scenario.label === "delete")!;
    expect(await count(removed.ids.partition)).toBe(1);
    expect(await analyticsCounts(removed, "partition")).toEqual(
      new Map([[removed.sibling.deviceId, 1]]),
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
      expect(await count(scenario.ids[kind])).toBe(1);
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
