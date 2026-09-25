// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A phone's cursor write, after something else advanced the write epoch.
 *
 * The write-epoch fence refuses a page whose author claimed authority before
 * the source was wiped. A collector participates in that protocol: it
 * claims an attempt, is handed the epoch, and quotes it back on every write.
 * A phone does not — the iOS and Android clients hold `write:<source-type>`
 * rather than `write:*`, never call the attempt routes, and post a bare
 * cursor. For those scoped writers the gateway supplies the epoch itself,
 * reading the row's current value instead of failing the fence on an absent
 * one, which is what `POST /documents`, `/documents/delete`,
 * `/documents/reconcile` and `/documents/with-cursor` all do.
 *
 * This pins that a phone keeps its cursor across the one event it cannot
 * observe: an operator resync, which wipes the source and advances the epoch
 * without telling the phone. The epoch is asserted to have actually moved
 * before the cursor write, so a resync that stopped advancing it would fail
 * the test rather than let it pass for the wrong reason.
 */
import "./synth-env.js";
import SqliteDatabase from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness, type HarnessDevice } from "./synth-harness.js";

const HEALTH = "apple-health:ios-synth-johnsmith";

describe("a phone's cursor write authority", () => {
  let harness: SyntheticE2EHarness;
  let phone: HarnessDevice;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable" });
    await harness.start();
    phone = harness.deviceForSource(HEALTH);
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  /** The epoch of the source's shared cursor row, read straight from the store. */
  const writeEpoch = (): number => {
    const db = new SqliteDatabase(harness.getDbPath(), { readonly: true });
    try {
      const row = db
        .prepare<
          [string],
          { epoch: number }
        >("SELECT epoch FROM source_wipe_epoch WHERE source_id = ? AND device_id = ''")
        .get(HEALTH);
      return row?.epoch ?? 0;
    } finally {
      db.close();
    }
  };

  /** Post a cursor the way a phone does: its own token, no `writeEpoch`. */
  const postCursorAsPhone = async (cursor: Record<string, unknown>) => {
    const res = await fetch(`${harness.gatewayUrl}/sync-state/${encodeURIComponent(HEALTH)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${phone.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cursor }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { ok: boolean; rejected?: boolean };
  };

  const cursorAsPhone = async () => {
    const res = await fetch(`${harness.gatewayUrl}/sync-state/${encodeURIComponent(HEALTH)}`, {
      headers: { Authorization: `Bearer ${phone.token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { cursor?: Record<string, unknown> | null };
  };

  test("the phone hosts the source as a scoped writer", () => {
    expect(phone.kind).toBe("ios");
    expect(phone.sourceIds).toContain(HEALTH);
  });

  test("an operator resync advances the epoch the phone never sees", async () => {
    await harness.triggerSyncAndWait(HEALTH, 60_000, phone);
    expect((await cursorAsPhone()).cursor).toBeTruthy();

    const before = writeEpoch();
    const res = await harness.gatewayFetch(`/admin/sources/${encodeURIComponent(HEALTH)}/resync`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(200);

    // The fence only bites once the epoch is above zero, so the rest of this
    // file is only meaningful if the resync actually moved it.
    expect(writeEpoch()).toBeGreaterThan(before);
    expect(writeEpoch()).toBeGreaterThan(0);
  }, 120_000);

  test("the phone's next cursor write is accepted and persisted", async () => {
    const cursor = { anchor: "resync-anchor-1", lastSyncedAt: "2026-02-01T10:00:00.000Z" };
    expect(await postCursorAsPhone(cursor)).toEqual({ ok: true });
    expect((await cursorAsPhone()).cursor).toMatchObject(cursor);
  }, 60_000);

  test("a later cursor write from the same phone still lands", async () => {
    const cursor = { anchor: "resync-anchor-2", lastSyncedAt: "2026-02-02T10:00:00.000Z" };
    expect(await postCursorAsPhone(cursor)).toEqual({ ok: true });
    expect((await cursorAsPhone()).cursor).toMatchObject(cursor);
  }, 60_000);
});
