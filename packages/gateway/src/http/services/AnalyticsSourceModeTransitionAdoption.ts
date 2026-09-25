// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { listCursorRows } from "../../data/repositories/SyncStateRepository.js";
import { epochScope, type SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import type { AnalyticsDb } from "../../analytics-db.js";
import type { DeviceId, SourceId } from "@omnesis/types";
import type Database from "better-sqlite3";
import type { SourceModeTransitionAdoption } from "./SourceModeTransitionCoordinator.js";

/** Fenced production bridge from the durable SQLite journal into DuckDB. */
export class AnalyticsSourceModeTransitionAdoption implements SourceModeTransitionAdoption {
  constructor(
    private readonly deps: {
      db: Database.Database;
      analyticsDb: AnalyticsDb;
      writeEpochFence: SourceWriteEpochFence;
    },
  ) {}

  async adoptExclusiveToPartitioned(sourceId: SourceId, ownerDeviceId: DeviceId): Promise<void> {
    const scopes = listCursorRows(this.deps.db, sourceId).map((cursorRow) =>
      epochScope(sourceId, cursorRow),
    );
    await this.deps.writeEpochFence.runAll(scopes, async () => {
      await this.deps.analyticsDb.adoptExclusiveToPartitioned(sourceId, ownerDeviceId);
    });
  }
}
