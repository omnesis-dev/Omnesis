// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createSourceFilterListTables } from "./repositories/SourceFilterListRepository.js";
import type { Db } from "./types.js";

/**
 * The lists collectors publish for a source's filterable fields: one row per
 * list, its items, and the members of each item. An upgraded install starts
 * with none; each collector publishes its lists on its next sync, because the
 * gateway reports no digest for them.
 */
export function addSourceFilterLists(db: Db): void {
  createSourceFilterListTables(db);
}
