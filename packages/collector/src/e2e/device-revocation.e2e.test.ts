// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Device revocation E2E.
 *
 * Unpairing REVOKES: the device row survives with `revokedAt`, its live
 * WebSocket is evicted, its sources stay attached. Forgetting (hard delete)
 * is refused while the device still hosts sources and succeeds once they
 * are gone. Asserted against two paired pseudo-collectors.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

async function deviceRow(
  harness: MultiCollectorHarness,
  id: string,
): Promise<{ id: string; online: boolean; revokedAt: number | null } | undefined> {
  const { items } = await harness.json<{
    items: Array<{ id: string; online: boolean; revokedAt: number | null }>;
  }>("/admin/devices");
  return items.find((d) => d.id === id);
}

describe("device revocation", () => {
  let harness: MultiCollectorHarness;
  let keeper: PairedCollector;
  let doomed: PairedCollector;

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    keeper = await harness.addCollector({ name: "keeper", hostableSourceTypes: ["gmail-synth"] });
    doomed = await harness.addCollector({ name: "doomed", hostableSourceTypes: ["gmail-synth"] });
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("the doomed collector hosts a source and is online", async () => {
    const res = await fetch(`${doomed.gatewayBase}/devices/sources/bulk-upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${doomed.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [{ type: "gmail-synth", accountId: "doomed@example.com", enabled: true }],
      }),
    });
    expect(res.ok).toBe(true);
    expect((await deviceRow(harness, doomed.deviceId))?.online).toBe(true);
  });

  test("revoking keeps the row, marks it revoked, and evicts the live socket", async () => {
    const del = await harness.json<{ revoked?: boolean }>(`/admin/devices/${doomed.deviceId}`, {
      method: "DELETE",
    });
    expect(del.revoked).toBe(true);

    await waitForCondition(
      async () => {
        const row = await deviceRow(harness, doomed.deviceId);
        return row !== undefined && row.revokedAt !== null && row.online === false;
      },
      10_000,
      "revoked collector listed with revokedAt and no live connection",
    );

    // Its source stays attached, dormant.
    const { items } = await harness.json<{ items: Array<{ id: string; deviceId: string }> }>(
      "/admin/sources",
    );
    expect(items.find((s) => s.id === "gmail-synth:doomed@example.com")?.deviceId).toBe(
      doomed.deviceId,
    );
    // The other collector is untouched.
    expect((await deviceRow(harness, keeper.deviceId))?.online).toBe(true);
  });

  test("forget is refused while the device hosts a source, then succeeds", async () => {
    let refused: { status?: number; body?: { code?: string; sources?: string[] } } | null = null;
    try {
      await harness.json(`/admin/devices/${doomed.deviceId}?forget=true`, { method: "DELETE" });
    } catch (err) {
      refused = err as { status?: number; body?: { code?: string; sources?: string[] } };
    }
    expect(refused?.status).toBe(409);
    expect(refused?.body?.code).toBe("DEVICE_STILL_HOSTS_SOURCES");
    expect(refused?.body?.sources).toContain("gmail-synth:doomed@example.com");

    await harness.json("/admin/sources/gmail-synth:doomed@example.com", { method: "DELETE" });
    const forgot = await harness.json<{ forgotten?: boolean }>(
      `/admin/devices/${doomed.deviceId}?forget=true`,
      { method: "DELETE" },
    );
    expect(forgot.forgotten).toBe(true);
    expect(await deviceRow(harness, doomed.deviceId)).toBeUndefined();
  });
});
