// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test, vi } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createSource } from "../../data/repositories/SourceRepository.js";
import { epochScope, SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import { AnalyticsSourceModeTransitionAdoption } from "./AnalyticsSourceModeTransitionAdoption.js";
import type { AnalyticsDb } from "../../analytics-db.js";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe("AnalyticsSourceModeTransitionAdoption", () => {
  test("waits for an in-flight shared analytics page and fences the future owner scope", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const owner = createDevice(db, {
      name: "collector-east",
      kind: "collector",
      capabilities: { hostableSourceTypes: [SourceType("notes-synth")] },
    });
    const source = createSource(db, {
      type: SourceType("notes-synth"),
      accountId: AccountId("fictional"),
      deviceId: owner.id,
      multiDeviceMode: "exclusive",
    });
    const fence = new SourceWriteEpochFence();
    let releaseShared!: () => void;
    let releaseOwner!: () => void;
    const sharedBlocked = new Promise<void>((resolve) => {
      releaseShared = resolve;
    });
    const ownerBlocked = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const sharedPage = fence.run(epochScope(source.id, ""), async () => sharedBlocked);
    const ownerPage = fence.run(epochScope(source.id, owner.id), async () => ownerBlocked);
    const adopt = vi.fn(async () => {});
    const bridge = new AnalyticsSourceModeTransitionAdoption({
      db,
      analyticsDb: { adoptExclusiveToPartitioned: adopt } as unknown as AnalyticsDb,
      writeEpochFence: fence,
    });

    let settled = false;
    const transition = bridge.adoptExclusiveToPartitioned(source.id, owner.id).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(adopt).not.toHaveBeenCalled();

    releaseShared();
    await sharedPage;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(adopt).not.toHaveBeenCalled();
    releaseOwner();
    await ownerPage;
    await transition;
    expect(adopt).toHaveBeenCalledWith(source.id, owner.id);
  });
});
