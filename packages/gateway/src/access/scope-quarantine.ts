// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "../data/types.js";
type Owner = "level" | "grant";

function columns(db: Db, table: string): Set<string> {
  return new Set(
    db
      .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
}

/** A linked grant inherits its level's quarantine, including grants created later. */
export function isScopeQuarantined(db: Db, owner: Owner, id: string, capability: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='access_scope_legacy_denials'").get())
    return false;
  if (
    db
      .prepare(
        "SELECT 1 FROM access_scope_legacy_denials WHERE owner_kind=? AND owner_id=? AND capability=?",
      )
      .get(owner, id, capability)
  )
    return true;
  return (
    owner === "grant" &&
    columns(db, "access_grants").has("level_id") &&
    !!db
      .prepare(
        `SELECT 1 FROM access_grants g JOIN access_scope_legacy_denials q ON q.owner_kind='level' AND q.owner_id=g.level_id WHERE g.id=? AND q.capability=?`,
      )
      .get(id, capability)
  );
}
