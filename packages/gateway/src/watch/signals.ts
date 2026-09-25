// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The two gateway-owned facts behind {@link isReplayingHistory}, read from the
 * registries that hold them.
 *
 * Its own module so the classification stays testable against a hand-written
 * object, and so the wiring file holds one line instead of two closures.
 *
 * Both lookups run inside an event-bus handler — synchronously on the main
 * thread, once per row of every sync page — so neither may read a database or
 * allocate. `isImporting` scans a map of at most a handful of live flows
 * without materializing it, and the sync registry is an in-memory map.
 */

import { trySourceId } from "@omnesis/types";
import type { ImportFlowRegistry } from "../import-flows.js";
import type { SyncStatusRegistry } from "../sync-status.js";
import type { SyncPhaseSignals } from "./replaying-history.js";

export function gatewaySyncPhaseSignals(deps: {
  syncStatus: SyncStatusRegistry;
  importFlows: ImportFlowRegistry;
}): SyncPhaseSignals {
  return {
    importing: (sourceId) => deps.importFlows.isImporting(sourceId),
    reportedPhase: (sourceId) => {
      // A malformed source id is not worth throwing over from a bus handler:
      // the bus would swallow it and one row would vanish with a log line.
      // Unparseable means unknown, and unknown means live.
      const id = trySourceId(sourceId);
      return id === null ? undefined : deps.syncStatus.get(id)?.progress?.phase;
    },
  };
}
