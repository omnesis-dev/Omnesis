// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, vi } from "vitest";
import { createDatabase } from "../../db.js";
import { InsufficientStorageError } from "../errors.js";
import { SourceSyncStateService } from "./SourceSyncStateService.js";
import type { WriteGate } from "../../write-gate.js";

it("does not claim new attempts or advance legacy cursors while capacity is blocked", async () => {
  const db = createDatabase(":memory:");
  const beginSyncAttempt = vi.fn(async () => 3);
  const setSyncState = vi.fn(async () => true);
  let blocked = true;
  const service = new SourceSyncStateService({
    db,
    writeGate: { beginSyncAttempt, setSyncState } as unknown as WriteGate,
    assertStorageCanGrow: () => {
      if (blocked) throw new InsufficientStorageError("Storage limit reached");
    },
  });
  try {
    await expect(service.beginAttempt("example:one")).rejects.toMatchObject({ status: 507 });
    await expect(service.setLegacyState("example:one", { page: 2 }, {})).rejects.toMatchObject({
      status: 507,
    });
    expect(beginSyncAttempt).not.toHaveBeenCalled();
    expect(setSyncState).not.toHaveBeenCalled();
    blocked = false;
    await expect(service.beginAttempt("example:one")).resolves.toBe(3);
    await expect(service.setLegacyState("example:one", { page: 2 }, {})).resolves.toBe(true);
    expect(setSyncState).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
  }
});
