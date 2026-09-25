// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A sync failure the operator has to act on, end to end over real collector
 * connections: the structured remedy a collector reports with its error is
 * what the gateway serves on the source's status — the affordance the portal
 * and the CLI render — while the raw message stays beside it for diagnostics.
 *
 * What the acceptance list for that affordance pins: a failure reported with
 * a remedy shows it; a generic failure reported without one never has one
 * attributed to it; on a source several devices host, only the member that
 * hit the failure carries it; it survives a gateway restart; and the member's
 * own recovery clears it.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

const REPLICATED = "notes-synth:shared@example.com";
const EXCLUSIVE = "gmail-synth:shared@example.com";

const REMEDY = {
  summary: "Disk access is required",
  steps: [
    "Open the privacy settings pane.",
    "Add the executable running the collector to the list and switch it on.",
  ],
  executable: "/opt/example/bin/node",
  restartRequired: true,
};

interface MemberStatus {
  deviceId: string;
  state: string;
  errorMessage?: string;
  remediation?: typeof REMEDY;
}

interface SourceStatus extends MemberStatus {
  members?: MemberStatus[];
}

async function bulkUpsert(
  c: PairedCollector,
  entries: Array<{ type: string; accountId: string }>,
): Promise<{ errors: Array<{ error: string }> }> {
  const res = await fetch(`${c.gatewayBase}/devices/sources/bulk-upsert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sources: entries.map((e) => ({ ...e, enabled: true })) }),
  });
  if (!res.ok) throw new Error(`bulk-upsert failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { errors: Array<{ error: string }> };
}

describe("structured remediation on a source's status", () => {
  let harness: MultiCollectorHarness;
  let macbook: PairedCollector;
  let linuxbox: PairedCollector;

  const statusOf = (id: string) =>
    harness.json<SourceStatus>(`/admin/sync/status/${encodeURIComponent(id)}`);
  /**
   * What the gateway says about one member: its own entry while several
   * members have reported or persisted, the source's status when only this
   * device has anything on record, nothing when the status names another.
   */
  const memberOf = async (id: string, deviceId: string): Promise<MemberStatus | undefined> => {
    const status = await statusOf(id);
    if (status.members) return status.members.find((m) => m.deviceId === deviceId);
    return status.deviceId === deviceId ? status : undefined;
  };
  /** Whether the member's own cursor row carries a persisted remedy. */
  const remedyPersistedFor = async (deviceId: string): Promise<boolean> => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const row = db
        .prepare<
          [string, string],
          { last_error_remediation: string | null }
        >("SELECT last_error_remediation FROM sync_state WHERE source_id = ? AND device_id = ?")
        .get(REPLICATED, deviceId);
      return row?.last_error_remediation != null;
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    const modes = { "notes-synth": "replicated" as const };
    macbook = await harness.addCollector({
      name: "macbook",
      hostableSourceTypes: ["gmail-synth", "notes-synth"],
      multiDeviceModes: modes,
      syncLease: true,
    });
    linuxbox = await harness.addCollector({
      name: "linuxbox",
      hostableSourceTypes: ["gmail-synth", "notes-synth"],
      multiDeviceModes: modes,
      syncLease: true,
    });
    expect(
      (
        await bulkUpsert(macbook, [
          { type: "notes-synth", accountId: "shared@example.com" },
          { type: "gmail-synth", accountId: "shared@example.com" },
        ])
      ).errors,
    ).toEqual([]);
    expect(
      (await bulkUpsert(linuxbox, [{ type: "notes-synth", accountId: "shared@example.com" }]))
        .errors,
    ).toEqual([]);
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("a failure reported with a remedy serves it beside the raw message", async () => {
    macbook.ws.emitEvent("sync.status", {
      sourceId: EXCLUSIVE,
      deviceId: macbook.deviceId,
      state: "error",
      errorMessage: "Cannot open the mailbox — disk access is required.",
      remediation: REMEDY,
    });
    await waitForCondition(
      async () => (await statusOf(EXCLUSIVE)).state === "error",
      5_000,
      "the failure reached the gateway",
    );
    const status = await statusOf(EXCLUSIVE);
    expect(status.remediation).toEqual(REMEDY);
    expect(status.errorMessage).toBe("Cannot open the mailbox — disk access is required.");
  });

  test("a generic failure is never given a remedy it did not report", async () => {
    macbook.ws.emitEvent("sync.status", {
      sourceId: EXCLUSIVE,
      deviceId: macbook.deviceId,
      state: "error",
      errorMessage: "EPERM: operation not permitted, open '/var/example/cache'",
    });
    await waitForCondition(
      async () => (await statusOf(EXCLUSIVE)).errorMessage?.startsWith("EPERM") === true,
      5_000,
      "the generic failure reached the gateway",
    );
    const status = await statusOf(EXCLUSIVE);
    expect(status.state).toBe("error");
    expect(status.remediation).toBeUndefined();
  });

  test("on a source two devices host, only the member that hit the failure carries it", async () => {
    macbook.ws.emitEvent("sync.status", {
      sourceId: REPLICATED,
      deviceId: macbook.deviceId,
      state: "completed",
      completedAt: Date.now(),
    });
    linuxbox.ws.emitEvent("sync.status", {
      sourceId: REPLICATED,
      deviceId: linuxbox.deviceId,
      state: "error",
      errorMessage: "Cannot open the notes database — disk access is required.",
      remediation: REMEDY,
    });
    await waitForCondition(
      async () => (await statusOf(REPLICATED)).members?.length === 2,
      5_000,
      "both members reported their status",
    );
    // Pin the attribution against persisted state too: the persist runs
    // behind the status update, and a sibling without a row of its own must
    // not inherit this row once it lands.
    await waitForCondition(
      () => remedyPersistedFor(linuxbox.deviceId),
      5_000,
      "the remedy was persisted on the member's row",
    );
    const status = await statusOf(REPLICATED);
    const byDevice = new Map(status.members!.map((m) => [m.deviceId, m]));
    expect(byDevice.get(linuxbox.deviceId)).toMatchObject({
      state: "error",
      remediation: REMEDY,
    });
    expect(byDevice.get(macbook.deviceId)?.state).not.toBe("error");
    expect(byDevice.get(macbook.deviceId)?.remediation).toBeUndefined();
  });

  test("the remedy survives a gateway restart on the member that reported it", async () => {
    await harness.restartGateway();

    // Only the failing member's row survived (a completed sync without a
    // cursor save leaves no row), so the source's status is that member's,
    // and it is attributed to it.
    const member = await memberOf(REPLICATED, linuxbox.deviceId);
    expect(member).toMatchObject({ state: "error", remediation: REMEDY });
    const sibling = await memberOf(REPLICATED, macbook.deviceId);
    if (sibling) expect(sibling).not.toMatchObject({ state: "error" });
  }, 60_000);

  test("the member's own successful sync clears it", async () => {
    linuxbox.ws.emitEvent("sync.status", {
      sourceId: REPLICATED,
      deviceId: linuxbox.deviceId,
      state: "completed",
      completedAt: Date.now(),
    });
    await waitForCondition(
      async () => (await memberOf(REPLICATED, linuxbox.deviceId))?.state !== "error",
      5_000,
      "the member recovered",
    );
    const member = await memberOf(REPLICATED, linuxbox.deviceId);
    expect(member).toBeDefined();
    expect(member?.remediation).toBeUndefined();
    expect(member?.errorMessage).toBeUndefined();

    // And it stays clear once the live report is gone: nothing on record
    // names this member as failing any more.
    await harness.restartGateway();
    expect(await remedyPersistedFor(linuxbox.deviceId)).toBe(false);
    const after = await memberOf(REPLICATED, linuxbox.deviceId);
    if (after) expect(after).not.toMatchObject({ state: "error" });
  }, 60_000);
});
