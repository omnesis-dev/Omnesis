// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { listSourceScopes, type SourceScopesEntry } from "../../access/scope-descriptors.js";
import type { Db } from "../../data/types.js";
import type { WriteGate } from "../../write-gate.js";

/** Persist provider-owned filter contracts independently of collector reconnects. */
export class SourceScopeService {
  constructor(
    private readonly reader: Db,
    private readonly writer: Pick<WriteGate, "upsertSourceScopes">,
  ) {}

  publish(entries: readonly SourceScopesEntry[]): Promise<{ stored: number }> {
    return this.writer.upsertSourceScopes(entries, Date.now());
  }

  list(): SourceScopesEntry[] {
    return listSourceScopes(this.reader);
  }
}
