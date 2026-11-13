// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { sourceFiltersInUse } from "../../access/source-filters-in-use.js";
import { listSourceScopes, type SourceScopesEntry } from "../../access/scope-descriptors.js";
import type { Db } from "../../data/types.js";
import type { WriteGate } from "../../write-gate.js";

/**
 * Persist provider-owned filter contracts independently of collector
 * reconnects. Nothing is stored while source filters are not in use: the
 * packaged contracts are seeded when the gateway starts with them in use.
 */
export class SourceScopeService {
  constructor(
    private readonly reader: Db,
    private readonly writer: Pick<WriteGate, "upsertSourceScopes">,
  ) {}

  async publish(entries: readonly SourceScopesEntry[]): Promise<{ stored: number }> {
    if (!sourceFiltersInUse(this.reader)) return { stored: 0 };
    return this.writer.upsertSourceScopes(entries, Date.now());
  }

  list(): SourceScopesEntry[] {
    return listSourceScopes(this.reader);
  }
}
