// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createSource, updateSource } from "../../data/repositories/SourceRepository.js";
import { getMobilePermissionHealth } from "../../data/repositories/MobilePermissionHealthRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { MobilePermissionHealthService } from "./MobilePermissionHealthService.js";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const owner = createDevice(db, { name: "Fictional owner phone", kind: "android" });
  const other = createDevice(db, { name: "Fictional other phone", kind: "ios" });
  const source = createSource(db, {
    type: SourceType("fictional-mobile"),
    accountId: AccountId("local"),
    deviceId: owner.id,
  });
  const notify = vi.fn(async () => true);
  const service = new MobilePermissionHealthService({
    writeGate: directWriteGate(db),
    notifier: { notify },
    now: () => 1_000_000,
  });
  return { db, owner, other, source, service, notify };
}

const healthy = { checkedAt: 1_000_000, validForMs: 60_000, capabilities: [] };

describe("MobilePermissionHealthService", () => {
  test("accepts only the owning phone and triggers evaluation", async () => {
    const { owner, other, source, service, notify } = fixture();
    await expect(service.report(owner.id, source.id, healthy)).resolves.toMatchObject({
      accepted: true,
    });
    expect(notify).toHaveBeenCalledWith(source.id);
    await expect(service.report(other.id, source.id, healthy)).rejects.toMatchObject({
      status: 403,
    });
  });

  test("rejects a future clock that could pin the observation order", async () => {
    const { owner, source, service } = fixture();
    await expect(
      service.report(owner.id, source.id, { ...healthy, checkedAt: 1_000_000 + 5 * 60_000 + 1 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("rejects a stale-on-arrival snapshot without overwriting current health", async () => {
    const { db, owner, source } = fixture();
    let now = 1_000_000;
    const service = new MobilePermissionHealthService({
      writeGate: directWriteGate(db),
      now: () => now,
    });
    await service.report(owner.id, source.id, healthy);
    now = 2_000_000;

    await expect(
      service.report(owner.id, source.id, {
        checkedAt: 1_100_000,
        validForMs: 60_000,
        capabilities: [],
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(getMobilePermissionHealth(db, source.id, now)?.health.checkedAt).toBe(1_000_000);
  });

  test("does not accept a report after the source is paused", async () => {
    const { db, owner, source, service } = fixture();
    updateSource(db, source.id, { enabled: false });
    await expect(service.report(owner.id, source.id, healthy)).rejects.toMatchObject({
      status: 400,
    });
  });

  test.each(["pause", "rehome"] as const)(
    "rechecks ownership inside the writer transaction after a %s interleaving",
    async (change) => {
      const { db, owner, other, source } = fixture();
      const gate = directWriteGate(db);
      const service = new MobilePermissionHealthService({
        writeGate: {
          replaceMobilePermissionHealth: async (input) => {
            updateSource(
              db,
              source.id,
              change === "pause" ? { enabled: false } : { deviceId: other.id },
            );
            return await gate.replaceMobilePermissionHealth(input);
          },
        },
        now: () => 1_000_000,
      });

      await expect(service.report(owner.id, source.id, healthy)).rejects.toMatchObject({
        status: change === "pause" ? 400 : 403,
      });
    },
  );
});
