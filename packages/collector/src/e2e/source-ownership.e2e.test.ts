// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Cross-collector source ownership E2E.
 *
 * The same account registered from a second collector must never silently
 * adopt (re-home) the existing source row — historically both hosts then
 * kept syncing one shared cursor. Asserted here end-to-end against two
 * paired pseudo-collectors:
 *
 *   - `/devices/sources/bulk-upsert` from the second collector rejects the
 *     entry (error names the current host), ownership unchanged
 *   - `POST /admin/sources` targeting the second collector → 409
 *     SOURCE_ALREADY_HOSTED
 *   - `PATCH /admin/sources/:id { deviceId }` is the one legitimate move:
 *     the gaining collector receives `source.added`, the losing collector
 *     receives a fresh `sources.snapshot` without the source (teardown
 *     without data/credential deletion)
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

const SOURCE_ID = "gmail-synth:shared@example.com";

async function bulkUpsert(
  c: PairedCollector,
  entries: Array<{ type: string; accountId: string }>,
): Promise<{
  count: number;
  sources: Array<{ id: string }>;
  errors: Array<{ error: string }>;
}> {
  const res = await fetch(`${c.gatewayBase}/devices/sources/bulk-upsert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sources: entries.map((e) => ({ ...e, enabled: true })) }),
  });
  if (!res.ok) throw new Error(`bulk-upsert failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    count: number;
    sources: Array<{ id: string }>;
    errors: Array<{ error: string }>;
  };
}

async function sourceDevice(harness: MultiCollectorHarness): Promise<string | undefined> {
  const { items } = await harness.json<{ items: Array<{ id: string; deviceId: string }> }>(
    "/admin/sources",
  );
  return items.find((s) => s.id === SOURCE_ID)?.deviceId;
}

describe("cross-collector source ownership", () => {
  let harness: MultiCollectorHarness;
  let macbook: PairedCollector;
  let linuxbox: PairedCollector;

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    macbook = await harness.addCollector({
      name: "macbook",
      hostableSourceTypes: ["gmail-synth"],
    });
    linuxbox = await harness.addCollector({
      name: "linuxbox",
      hostableSourceTypes: ["gmail-synth"],
    });
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("first registration lands on the registering collector", async () => {
    const result = await bulkUpsert(macbook, [
      { type: "gmail-synth", accountId: "shared@example.com" },
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.sources.map((s) => s.id)).toEqual([SOURCE_ID]);
    expect(await sourceDevice(harness)).toBe(macbook.deviceId);
  });

  test("the same account from a second collector is rejected, not adopted", async () => {
    const result = await bulkUpsert(linuxbox, [
      { type: "gmail-synth", accountId: "shared@example.com" },
    ]);
    expect(result.sources).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("macbook");
    // Ownership did not move.
    expect(await sourceDevice(harness)).toBe(macbook.deviceId);
  });

  test("POST /admin/sources targeting the second collector returns 409 naming the host", async () => {
    let failure: { status?: number; body?: { code?: string; error?: string } } | null = null;
    try {
      await harness.json("/admin/sources", {
        method: "POST",
        body: JSON.stringify({
          type: "gmail-synth",
          accountId: "shared@example.com",
          deviceId: linuxbox.deviceId,
        }),
      });
    } catch (err) {
      failure = err as { status?: number; body?: { code?: string; error?: string } };
    }
    expect(failure?.status).toBe(409);
    expect(failure?.body?.code).toBe("SOURCE_ALREADY_HOSTED");
    expect(failure?.body?.error).toContain("macbook");
    expect(await sourceDevice(harness)).toBe(macbook.deviceId);
  });

  test("PATCH deviceId moves the source: gainer gets source.added, loser gets a snapshot without it", async () => {
    macbook.receivedCommands.length = 0;
    linuxbox.receivedCommands.length = 0;

    const { source } = await harness.json<{ source: { deviceId: string } }>(
      `/admin/sources/${encodeURIComponent(SOURCE_ID)}`,
      { method: "PATCH", body: JSON.stringify({ deviceId: linuxbox.deviceId }) },
    );
    expect(source.deviceId).toBe(linuxbox.deviceId);
    expect(await sourceDevice(harness)).toBe(linuxbox.deviceId);

    // Gaining collector learns the source as an add.
    await waitForCondition(
      () =>
        linuxbox.receivedCommands.some(
          (cmd) =>
            cmd.type === "source.added" &&
            (cmd.payload as { source?: { id?: string } }).source?.id === SOURCE_ID,
        ),
      10_000,
      "gaining collector received source.added for the moved source",
    );
    // Losing collector gets its authoritative snapshot, which no longer
    // carries the source — the teardown signal that keeps data intact.
    await waitForCondition(
      () =>
        macbook.receivedCommands.some(
          (cmd) =>
            cmd.type === "sources.snapshot" &&
            !(cmd.payload as { sources?: Array<{ id?: string }> }).sources?.some(
              (s) => s.id === SOURCE_ID,
            ),
        ),
      10_000,
      "losing collector received a snapshot without the moved source",
    );
  });
});
