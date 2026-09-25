// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test, vi } from "vitest";
import { DeviceId, SourceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { enqueueSourceStreamCleanup } from "../../data/repositories/SourceStreamCleanupRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { SourceStreamCleanupCoordinator } from "./SourceStreamCleanupCoordinator.js";
import type { SourceDataRemovalService } from "./SourceDataRemovalService.js";
import type { StatusCache } from "./StatusCache.js";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
  vi.useRealTimers();
  databases.splice(0).forEach((db) => db.close());
});

describe("SourceStreamCleanupCoordinator", () => {
  test("shutdown cannot arm a retry after an in-flight cleanup fails", async () => {
    vi.useFakeTimers();
    const db = createDatabase(":memory:");
    databases.push(db);
    const job = enqueueSourceStreamCleanup(
      db,
      SourceId("visits-synth:shared"),
      DeviceId("11111111-1111-4111-8111-111111111111"),
    );
    let rejectCleanup!: (error: Error) => void;
    const deleteStream = vi.fn(
      () => new Promise<void>((_resolve, reject) => (rejectCleanup = reject)),
    );
    const coordinator = new SourceStreamCleanupCoordinator({
      db,
      writeGate: directWriteGate(db),
      sourceDataRemoval: { deleteStream } as unknown as SourceDataRemovalService,
      statusCache: { bump: vi.fn() } as unknown as StatusCache,
    });

    const attempt = coordinator.cleanup(job);
    await vi.waitFor(() => expect(deleteStream).toHaveBeenCalledTimes(1));
    coordinator.dispose();
    rejectCleanup(new Error("analytics unavailable"));
    await attempt;
    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(deleteStream).toHaveBeenCalledTimes(1);
  });
});
