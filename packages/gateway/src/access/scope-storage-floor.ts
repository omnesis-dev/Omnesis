// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SCOPE_POLICY_STORAGE_PROTOCOL } from "./scope-policy-encoding.js";
import type { Db } from "../data/types.js";
type Owner = "level" | "grant";

/** Old binaries cannot erase the protocol marker; the exemption never commits. */
export function withScopePolicyMutation<T>(db: Db, owner: Owner, id: string, work: () => T): T {
  return db.transaction(() => {
    const inserted = db
      .prepare("INSERT OR IGNORE INTO scope_policy_mutation_context VALUES(?,?)")
      .run(owner, id).changes;
    try {
      return work();
    } finally {
      if (inserted)
        db.prepare(
          "DELETE FROM scope_policy_mutation_context WHERE owner_kind=? AND owner_id=?",
        ).run(owner, id);
    }
  })();
}

export function createScopeStorageFloor(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS scope_policy_mutation_context(owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,PRIMARY KEY(owner_kind,owner_id)) WITHOUT ROWID;`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS access_scope_legacy_denials(owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,capability TEXT NOT NULL,PRIMARY KEY(owner_kind,owner_id,capability)) WITHOUT ROWID;`,
  );
  for (const [owner, table] of [
    ["level", "access_levels"],
    ["grant", "access_grants"],
  ] as const)
    db.exec(`CREATE TRIGGER IF NOT EXISTS scope_policy_quarantine_${owner}_delete AFTER DELETE ON ${table} BEGIN
      DELETE FROM access_scope_legacy_denials WHERE owner_kind='${owner}' AND owner_id=OLD.id;
    END;`);
  const array = (row: string) =>
    `CASE WHEN json_valid(${row}.policies) THEN ${row}.policies ELSE 'null' END`;
  const invalid = `json_type(${array("NEW")}) IS NOT 'array' OR EXISTS(
   SELECT 1 FROM json_each(${array("NEW")}) p
   WHERE p.type<>'object' OR json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.minimumProtocol') IS NOT ${SCOPE_POLICY_STORAGE_PROTOCOL})`;
  const protectedOld = `(EXISTS(SELECT 1 FROM access_scope_policy_sources s WHERE s.owner_kind=OLD.owner_kind AND s.owner_id=OLD.owner_id AND s.capability=OLD.capability) OR EXISTS(SELECT 1 FROM access_scope_legacy_denials q WHERE q.owner_kind=OLD.owner_kind AND q.owner_id=OLD.owner_id AND q.capability=OLD.capability))`;
  const context = `EXISTS(SELECT 1 FROM scope_policy_mutation_context m WHERE m.owner_kind=OLD.owner_kind AND m.owner_id=OLD.owner_id)`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS scope_policy_protocol_insert BEFORE INSERT ON access_scope_capabilities BEGIN
   SELECT RAISE(ABORT,'Unsupported source filter storage protocol.') WHERE ${invalid};
 END;
 CREATE TRIGGER IF NOT EXISTS scope_policy_protocol_update BEFORE UPDATE ON access_scope_capabilities BEGIN
   SELECT RAISE(ABORT,'Unsupported source filter storage protocol.') WHERE ${invalid};
   SELECT RAISE(ABORT,'Source filters require a current editor.') WHERE ${protectedOld} AND NOT ${context}
     AND (json_array_length(${array("NEW")})=0 OR OLD.owner_kind IS NOT NEW.owner_kind OR OLD.owner_id IS NOT NEW.owner_id OR OLD.capability IS NOT NEW.capability);
 END;
 CREATE TRIGGER IF NOT EXISTS scope_policy_protocol_delete BEFORE DELETE ON access_scope_capabilities BEGIN
   SELECT RAISE(ABORT,'Source filters require a current editor.') WHERE ${protectedOld} AND NOT ${context}
    AND ((OLD.owner_kind='level' AND EXISTS(SELECT 1 FROM access_levels WHERE id=OLD.owner_id))
      OR (OLD.owner_kind='grant' AND EXISTS(SELECT 1 FROM access_grants WHERE id=OLD.owner_id)));
 END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS scope_policy_denial_update AFTER UPDATE ON access_scope_capabilities
    WHEN EXISTS(SELECT 1 FROM scope_policy_mutation_context m WHERE m.owner_kind=NEW.owner_kind AND m.owner_id=NEW.owner_id) BEGIN
      DELETE FROM access_scope_legacy_denials WHERE owner_kind=OLD.owner_kind AND owner_id=OLD.owner_id AND capability=OLD.capability;
    END;
    CREATE TRIGGER IF NOT EXISTS scope_policy_denial_delete AFTER DELETE ON access_scope_capabilities BEGIN
      DELETE FROM access_scope_legacy_denials WHERE owner_kind=OLD.owner_kind AND owner_id=OLD.owner_id AND capability=OLD.capability;
    END;`);
  for (const [table, key, owner] of [
    ["access_level_capabilities", "level_id", "level"],
    ["access_grant_capabilities", "grant_id", "grant"],
  ] as const) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      continue;
    const exempt = `EXISTS(SELECT 1 FROM scope_policy_mutation_context m WHERE m.owner_kind='${owner}' AND m.owner_id=NEW.${key})`;
    const expected = `SELECT id FROM (SELECT j.value AS id FROM json_each(c.source_ids) j WHERE
      (c.source_mode='allowlist' AND NOT EXISTS(SELECT 1 FROM access_scope_policy_sources f WHERE f.owner_kind=c.owner_kind AND f.owner_id=c.owner_id AND f.capability=c.capability AND f.source_id=j.value))
      OR c.source_mode='denylist'
      UNION SELECT f.source_id FROM access_scope_policy_sources f WHERE c.source_mode<>'allowlist' AND f.owner_kind=c.owner_kind AND f.owner_id=c.owner_id AND f.capability=c.capability)`;
    for (const event of ["INSERT", "UPDATE"]) {
      db.exec(`DROP TRIGGER IF EXISTS scope_legacy_${owner}_${event.toLowerCase()}`);
      db.exec(`CREATE TRIGGER scope_legacy_${owner}_${event.toLowerCase()} BEFORE ${event} ON ${table} WHEN NOT ${exempt} BEGIN
   SELECT RAISE(ABORT,'Source filters require conservative legacy permissions.') WHERE EXISTS(
    SELECT 1 FROM access_scope_capabilities c WHERE c.owner_kind='${owner}' AND c.owner_id=NEW.${key} AND c.capability=NEW.capability
    AND EXISTS(SELECT 1 FROM access_scope_policy_sources f WHERE f.owner_kind=c.owner_kind AND f.owner_id=c.owner_id AND f.capability=c.capability)
    AND NOT EXISTS(SELECT 1 FROM access_scope_legacy_denials q WHERE q.owner_kind=c.owner_kind AND q.owner_id=c.owner_id AND q.capability=c.capability)
    AND (NOT json_valid(NEW.source_ids) OR json_type(CASE WHEN json_valid(NEW.source_ids) THEN NEW.source_ids ELSE 'null' END)<>'array'
      OR NEW.source_mode<>CASE WHEN c.source_mode='allowlist' THEN 'allowlist' ELSE 'denylist' END
      OR EXISTS(SELECT value FROM json_each(CASE WHEN json_valid(NEW.source_ids) THEN NEW.source_ids ELSE '[]' END) EXCEPT ${expected})
      OR EXISTS(${expected} EXCEPT SELECT value FROM json_each(CASE WHEN json_valid(NEW.source_ids) THEN NEW.source_ids ELSE '[]' END)))
   );
   SELECT RAISE(ABORT,'Unreadable source filters require legacy deny-all permissions.') WHERE EXISTS(
    SELECT 1 FROM access_scope_legacy_denials q WHERE q.owner_kind='${owner}' AND q.owner_id=NEW.${key} AND q.capability=NEW.capability)
    AND NOT (NEW.source_mode='allowlist' AND json_valid(NEW.source_ids) AND json_array_length(CASE WHEN json_valid(NEW.source_ids) THEN NEW.source_ids ELSE '[null]' END)=0);
  END;`);
    }
  }
}
