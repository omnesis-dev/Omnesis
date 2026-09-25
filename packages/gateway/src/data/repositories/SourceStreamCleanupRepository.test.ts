// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from "vitest";
import { DeviceId, SourceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import {
  completeSourceStreamCleanup,
  enqueueSourceStreamCleanup,
  isCurrentSourceStreamCleanup,
  listPendingSourceStreamCleanups,
  recordSourceStreamCleanupFailure,
} from "./SourceStreamCleanupRepository.js";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe("SourceStreamCleanupRepository", () => {
  test("a stale completion cannot finish a newer cleanup generation", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const sourceId = SourceId("visits-synth:shared");
    const deviceId = DeviceId("11111111-1111-4111-8111-111111111111");

    const first = enqueueSourceStreamCleanup(db, sourceId, deviceId, 100);
    expect(recordSourceStreamCleanupFailure(db, first, "temporary failure")).toBe(true);
    expect(completeSourceStreamCleanup(db, first, 200)).toBe(true);
    const second = enqueueSourceStreamCleanup(db, sourceId, deviceId, 300);

    expect(second).toMatchObject({ generation: 2, attempts: 0 });
    expect(completeSourceStreamCleanup(db, first, 400)).toBe(false);
    expect(isCurrentSourceStreamCleanup(db, second)).toBe(true);
    expect(listPendingSourceStreamCleanups(db)).toEqual([second]);
  });
});
