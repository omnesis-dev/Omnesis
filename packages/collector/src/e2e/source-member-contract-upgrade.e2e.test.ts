// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

test("an additive member-config upgrade resumes before an offline peer upgrades without widening mutations", async () => {
  const harness = new MultiCollectorHarness();
  try {
    await harness.start();
    const options = {
      hostableSourceTypes: ["notes-synth"],
      multiDeviceModes: { "notes-synth": "replicated" as const },
      syncLease: true,
    };
    const first = await harness.addCollector({ name: "first", ...options });
    const second = await harness.addCollector({ name: "second", ...options });
    const sourceId = "notes-synth:upgrade@example.com";
    const sourcePath = `/sync-state/${encodeURIComponent(sourceId)}`;
    const request = (collector: PairedCollector, path: string, body?: unknown, method = "POST") =>
      fetch(`${collector.gatewayBase}${path}`, {
        method: body === undefined ? "GET" : method,
        headers: { Authorization: `Bearer ${collector.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    for (const collector of [first, second]) {
      const response = await fetch(`${collector.gatewayBase}/devices/sources/bulk-upsert`, {
        method: "POST",
        headers: { Authorization: `Bearer ${collector.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: [{ type: "notes-synth", accountId: "upgrade@example.com", enabled: true }],
        }),
      });
      expect(response.ok).toBe(true);
      expect((await response.json()).errors).toEqual([]);
    }
    expect(
      (
        await harness.pushDocuments(first, [
          { sourceId, externalId: "before", content: "Before upgrade" },
        ])
      ).ingested,
    ).toBe(1);
    const snapshotSource = (collector: PairedCollector) => {
      const latest = collector.receivedCommands
        .filter((command) => command.type === "sources.snapshot")
        .at(-1);
      return (
        latest?.payload as
          | {
              sources: Array<{ id: string; config: { params?: Record<string, string> } }>;
            }
          | undefined
      )?.sources.find((source) => source.id === sourceId);
    };
    const snapshotHasSource = (collector: PairedCollector) => !!snapshotSource(collector);
    await harness.disconnectCollector(second);
    first.receivedCommands.length = 0;
    await harness.reannounceCollector(first, {
      ...first.capabilities,
      memberScopedParams: { "notes-synth": ["folder"] },
      sourceContract: { min: 1, max: 1 },
    });
    await waitForCondition(
      () => first.receivedCommands.some((command) => command.type === "sources.snapshot"),
      10_000,
      "first upgraded snapshot",
    );
    expect(snapshotHasSource(first)).toBe(true);
    expect(snapshotSource(first)?.config.params).toBeUndefined();
    // Hello delivers existing configuration but does not adopt the data wire
    // contract. An old member's in-flight read still works while it is offline.
    expect((await request(second, sourcePath)).status).toBe(200);
    expect((await request(first, sourcePath)).status).toBe(200);
    const mutation = await request(first, "/devices/sources/bulk-upsert-member-config", {
      sources: [
        {
          type: "notes-synth",
          accountId: "upgrade@example.com",
          memberConfig: { params: { folder: "/example/first" } },
        },
      ],
    });
    expect(mutation.status).toBe(200);
    expect((await mutation.json()).errors).toHaveLength(1);
    const third = await harness.addCollector({
      name: "third",
      ...options,
      memberScopedParams: { "notes-synth": ["folder"] },
    });
    const join = await request(first, `/admin/sources/${encodeURIComponent(sourceId)}/members`, {
      deviceId: third.deviceId,
    });
    expect(join.status).toBe(409);
    const edit = await request(
      first,
      `/admin/sources/${encodeURIComponent(sourceId)}/members/${first.deviceId}`,
      { configOverride: { params: { folder: "/example/first" } } },
      "PATCH",
    );
    expect(edit.status).toBe(409);

    const begin = await request(first, `${sourcePath}/begin`, {
      attemptId: "11111111-1111-4111-8111-111111111111",
    });
    expect(begin.status).toBe(200);
    const { wipeEpoch } = await begin.json();
    const commit = await request(first, "/documents/with-cursor", {
      providerId: sourceId,
      sourceId,
      documents: [
        {
          providerId: sourceId,
          sourceId,
          externalId: "during-upgrade",
          title: "Upgrade fixture",
          content: "Written while the other member is offline",
          contentHash: "upgrade-fixture-hash",
          metadata: {},
          sourceCreatedAt: "2026-01-01T00:00:00.000Z",
          sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      cursor: { page: 7 },
      hasMore: false,
      wipeEpoch,
    });
    expect(commit.status).toBe(200);
    const committed = await commit.json();
    expect(committed).toMatchObject({ ingested: 1 });
    expect(committed.rejected).not.toBe(true);
    expect(await (await request(first, sourcePath)).json()).toMatchObject({ cursor: { page: 7 } });
    const oldAfterAdoption = await request(second, sourcePath);
    expect(oldAfterAdoption.status).toBe(409);
    expect(await oldAfterAdoption.json()).toMatchObject({
      code: "SOURCE_WIRE_CONTRACT_UNSUPPORTED",
    });

    await harness.reannounceCollector(second, {
      ...second.capabilities,
      memberScopedParams: { "notes-synth": ["folder"] },
      sourceContract: { min: 1, max: 1 },
    });
    await waitForCondition(
      () => snapshotHasSource(first) && snapshotHasSource(second),
      10_000,
      "both upgraded sources delivered",
    );
    // Once all current members agree, mutation can use the extended contract.
    // A second additive extension must still deliver only the caller's overlay.
    for (const collector of [first, second]) {
      const response = await request(
        collector,
        `/admin/sources/${encodeURIComponent(sourceId)}/members/${collector.deviceId}`,
        { configOverride: { params: { folder: `/example/${collector.name}` } } },
        "PATCH",
      );
      expect(response.status).toBe(200);
    }
    await harness.disconnectCollector(second);
    first.receivedCommands.length = 0;
    await harness.reannounceCollector(first, {
      ...first.capabilities,
      memberScopedParams: { "notes-synth": ["folder", "archiveFolder"] },
    });
    await waitForCondition(
      () => snapshotHasSource(first),
      10_000,
      "additive upgrade retains own overlay",
    );
    expect(snapshotSource(first)?.config.params).toEqual({ folder: "/example/first" });
    second.receivedCommands.length = 0;
    await harness.reannounceCollector(second, {
      ...second.capabilities,
      memberScopedParams: { "notes-synth": ["folder", "archiveFolder"] },
    });
    await waitForCondition(
      () => snapshotHasSource(second),
      10_000,
      "peer retains own overlay after repin",
    );
    expect(snapshotSource(second)?.config.params).toEqual({ folder: "/example/second" });
    expect(await (await request(first, sourcePath)).json()).toMatchObject({ cursor: { page: 7 } });
  } finally {
    await harness.destroy();
  }
}, 60_000);
