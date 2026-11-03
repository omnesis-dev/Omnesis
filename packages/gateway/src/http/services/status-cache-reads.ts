// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { getLatestActivityBySource } from "../../data/repositories/DocumentRepository.js";
import { listSyncStates } from "../../data/repositories/SyncStateRepository.js";
import { listDevices } from "../../data/repositories/DeviceRepository.js";
import {
  listDeviceIdsHostingSources,
  listSources,
} from "../../data/repositories/SourceRepository.js";
import type { ReadPort } from "../../scheduler/read-port.js";
import type Database from "better-sqlite3";

/** Everything the status cache holds from `omnesis.db`, read in one snapshot. */
export interface StatusCacheSnapshot {
  latestActivity: ReturnType<typeof getLatestActivityBySource>;
  sources: ReturnType<typeof listSources>;
  syncStates: ReturnType<typeof listSyncStates>;
  devices: ReturnType<typeof listDevices>;
  /** Devices that still own or are members of a source; an array so it crosses a worker. */
  sourceHostingDeviceIds: ReturnType<typeof listDeviceIdsHostingSources>;
}

export function readStatusCacheSnapshot(db: Database.Database): StatusCacheSnapshot {
  return db.transaction(() => ({
    latestActivity: getLatestActivityBySource(db),
    sources: listSources(db),
    syncStates: listSyncStates(db),
    devices: listDevices(db),
    sourceHostingDeviceIds: listDeviceIdsHostingSources(db),
  }))();
}

/**
 * The status cache's periodic read. Every sync-state row carries its source's
 * cursor, which for a mail or message source can be large, so on an encrypted
 * store reading them all is a walk over many decrypted pages; the gateway runs
 * it on a read worker so the two-second refresh never holds the event loop.
 */
export const STATUS_CACHE_READS = { statusCacheSnapshot: readStatusCacheSnapshot };

export type StatusCacheReads = ReadPort<typeof STATUS_CACHE_READS>;
