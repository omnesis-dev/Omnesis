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

/** Settings-only recovery: never replace a legacy owner's extra revocation with a broader grant. */
export function quarantineScopeAuthority(
  db: Db,
  owner: Owner,
  id: string,
  capability: string,
  bumped: Set<string>,
  mutate: (owner: Owner, id: string, work: () => void) => void,
): void {
  const targets: Array<[Owner, string]> = [[owner, id]];
  const grantColumns = columns(db, "access_grants");
  const levelId =
    owner === "level"
      ? id
      : grantColumns.has("level_id")
        ? db
            .prepare<[string], { level_id: string | null }>(
              "SELECT level_id FROM access_grants WHERE id=?",
            )
            .get(id)?.level_id
        : null;
  if (levelId) {
    targets.push(["level", levelId]);
    if (grantColumns.has("level_id"))
      for (const grant of db
        .prepare<[string], { id: string }>("SELECT id FROM access_grants WHERE level_id=?")
        .all(levelId))
        targets.push(["grant", grant.id]);
  }
  for (const [kind, target] of targets) {
    const inserted = db
      .prepare("INSERT OR IGNORE INTO access_scope_legacy_denials VALUES(?,?,?)")
      .run(kind, target, capability).changes;
    const table = kind === "level" ? "access_levels" : "access_grants";
    const token = `${kind}:${target}`;
    if (inserted && !bumped.has(token) && columns(db, table).has("revision")) {
      db.prepare(`UPDATE ${table} SET revision=revision+1 WHERE id=?`).run(target);
      bumped.add(token);
    }
    const caps = kind === "level" ? "access_level_capabilities" : "access_grant_capabilities";
    const key = kind === "level" ? "level_id" : "grant_id";
    mutate(kind, target, () => {
      db.prepare(
        `UPDATE ${caps} SET source_mode='allowlist',source_ids='[]' WHERE ${key}=? AND capability=?`,
      ).run(target, capability);
    });
  }
}
