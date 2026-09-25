// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

export function addSourceWireContracts(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS source_wire_contracts (
    source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    minimum_version INTEGER NOT NULL CHECK (minimum_version > 0)
  )`);
}
