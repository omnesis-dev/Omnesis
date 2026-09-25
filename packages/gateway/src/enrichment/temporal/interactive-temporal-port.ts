// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { TemporalQueryService } from "./temporal-query-service.js";
import type Database from "better-sqlite3";
import type { TemporalReadPort } from "@omnesis/agent";
import type { AnalyticsDb } from "../../analytics-db.js";

type Db = Database.Database;

/** Unified read-only temporal port shared by interactive and background agents. */
export function createGatewayTemporalPort(
  db: Db,
  analyticsDb: AnalyticsDb,
  execution?: { maxWindowMs?: number },
): TemporalReadPort {
  const service = new TemporalQueryService(db, analyticsDb);
  return {
    query(input, signal) {
      return service.query(input, { ...execution, ...(signal ? { signal } : {}) });
    },
  };
}
