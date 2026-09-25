// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { MultiCollectorHarness, type PairedCollector } from "./multi-collector-harness.js";
import type { SyncIssue, SyncIssueStatus } from "@omnesis/types";

const SOURCE = "notes-synth:issues@example.com";
const ISSUE: SyncIssue = {
  code: "snapshot-withheld",
  scope: "partition",
  kind: "unknown",
  count: 1,
  subject: "Whole-source deletion detection",
  message: "Example partition could not be read",
  remediation: { summary: "Restore access", steps: ["Check permissions."], restartRequired: false },
};
interface Status {
  state: string;
  deviceId?: string;
  issues?: SyncIssueStatus[];
  members?: Array<{ deviceId: string; issues?: SyncIssueStatus[] }>;
}

test("completed sync issues survive restart and recover only on the reporting member's assessment", async () => {
  const harness = new MultiCollectorHarness();
  try {
    await harness.start();
    const collectors: PairedCollector[] = [];
    for (const name of ["fixture-first", "fixture-second"]) {
      const collector = await harness.addCollector({
        name,
        hostableSourceTypes: ["notes-synth"],
        multiDeviceModes: { "notes-synth": "replicated" },
        syncLease: true,
      });
      collectors.push(collector);
      const response = await fetch(`${harness.gatewayUrl}/devices/sources/bulk-upsert`, {
        method: "POST",
        headers: { Authorization: `Bearer ${collector.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: [{ type: "notes-synth", accountId: "issues@example.com", enabled: true }],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ errors: [] });
    }
    const [first, second] = collectors;
    const status = () => harness.json<Status>(`/admin/sync/status/${encodeURIComponent(SOURCE)}`);
    const memberIssues = async (deviceId: string) => {
      const current = await status();
      if (current.members)
        return current.members.find((member) => member.deviceId === deviceId)?.issues ?? [];
      return (current.deviceId === deviceId ? current.issues : undefined) ?? [];
    };
    const report = (collector: PairedCollector, issues?: SyncIssue[]) =>
      collector.ws.emitEvent("sync.status", {
        sourceId: SOURCE,
        state: "completed",
        completedAt: Date.now(),
        ...(issues === undefined ? {} : { issues }),
      });
    report(first, [ISSUE]);
    report(second, [ISSUE]);
    for (const collector of collectors) {
      await expect
        .poll(() => memberIssues(collector.deviceId), { timeout: 10_000 })
        .toEqual([expect.objectContaining({ ...ISSUE, since: expect.any(Number) })]);
    }
    const since = (await memberIssues(first.deviceId))[0].since;
    // No page has committed a cursor yet: completion alone is not a synced dataset.
    expect((await status()).state).toBe("idle");

    // Re-reporting the same unresolved issue must not reset its age.
    report(first, [ISSUE]);
    report(second, []);
    await expect.poll(() => memberIssues(second.deviceId), { timeout: 10_000 }).toEqual([]);
    expect(await memberIssues(first.deviceId)).toEqual([{ ...ISSUE, since }]);
    await harness.restartGateway();
    expect(await memberIssues(first.deviceId)).toEqual([{ ...ISSUE, since }]);
    expect(await memberIssues(second.deviceId)).toEqual([]);

    const committed = await fetch(
      `${harness.gatewayUrl}/sync-state/${encodeURIComponent(SOURCE)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${first.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ cursor: { bookmark: 1 } }),
      },
    );
    expect(committed.status).toBe(200);
    await expect.poll(async () => (await status()).state, { timeout: 10_000 }).toBe("synced");
    const doctor = await harness.json<{ checks: Array<{ id: string; status: string }> }>(
      "/admin/doctor",
    );
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringContaining(`sources.sync-issue.${SOURCE}`),
          status: "warn",
        }),
      ]),
    );

    // Omitted warnings from an old collector and an interrupted tick are not
    // an assessment that the partition can be enumerated again.
    report(first);
    first.ws.emitEvent("sync.status", {
      sourceId: SOURCE,
      state: "syncing",
      progress: { processed: 1 },
      issues: [],
    });
    await expect.poll(async () => (await status()).state, { timeout: 10_000 }).toBe("syncing");
    expect(await memberIssues(first.deviceId)).toEqual([{ ...ISSUE, since }]);
    report(first, []);
    await expect.poll(() => memberIssues(first.deviceId), { timeout: 10_000 }).toEqual([]);
    expect((await status()).issues ?? []).toEqual([]);
    await harness.restartGateway();
    expect((await status()).issues ?? []).toEqual([]);

    const invalid = { ...ISSUE, code: "invalid-snapshot", subject: "table_one" };
    const siblingTable = { ...invalid, subject: "table_two" };
    report(first, [ISSUE, invalid, siblingTable]);
    await expect.poll(() => memberIssues(first.deviceId), { timeout: 10_000 }).toHaveLength(3);
    first.ws.emitEvent("sync.status", {
      sourceId: SOURCE,
      state: "completed",
      issues: [],
      issueAssessments: [{ code: invalid.code, scope: invalid.scope, subject: invalid.subject }],
    });
    await expect
      .poll(async () => (await memberIssues(first.deviceId)).map((issue) => issue.subject), {
        timeout: 10_000,
      })
      .toEqual([ISSUE.subject, siblingTable.subject]);
    await harness.restartGateway();
    expect((await memberIssues(first.deviceId)).map((issue) => issue.subject)).toEqual([
      ISSUE.subject,
      siblingTable.subject,
    ]);
    report(first, []);
    await expect.poll(() => memberIssues(first.deviceId), { timeout: 10_000 }).toEqual([]);
  } finally {
    await harness.destroy();
  }
}, 90_000);
