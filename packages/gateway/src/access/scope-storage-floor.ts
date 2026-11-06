// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isScopeQuarantined, quarantineScopeAuthority } from "./scope-quarantine.js";
import { conservativeSources } from "./scope-legacy-boundary.js";
import { decodeStoredScopePolicies, encodeStoredScopePolicies } from "./scope-policy-encoding.js";
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
   WHERE p.type<>'object' OR json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.minimumProtocol') IS NOT 2)`;
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

/** Repair only configuration rows; unreadable authority gets a legacy deny-all projection. */
export function reconcileLegacyScopeBoundaries(db: Db): void {
  let cursor = 0;
  const bumped = new Set<string>();
  for (;;) {
    const rows = db
      .prepare<
        [number],
        {
          rowid: number;
          owner_kind: Owner;
          owner_id: string;
          capability: string;
          source_mode: "all" | "allowlist" | "denylist";
          source_ids: string;
          filter_revision: number;
          policies: string;
        }
      >(
        "SELECT rowid,owner_kind,owner_id,capability,source_mode,source_ids,filter_revision,policies FROM access_scope_capabilities WHERE rowid>? ORDER BY rowid LIMIT 100",
      )
      .all(cursor);
    if (!rows.length) break;
    for (const row of rows) {
      let marked: string | undefined;
      let empty = false;
      let legacy: { sourceMode: "all" | "allowlist" | "denylist"; sourceIds: string[] } = {
        sourceMode: "allowlist",
        sourceIds: [],
      };
      try {
        const ids: unknown = JSON.parse(row.source_ids);
        if (
          !["all", "allowlist", "denylist"].includes(row.source_mode) ||
          !Array.isArray(ids) ||
          !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 512) ||
          ids.length > 256 ||
          (row.source_mode === "all" && ids.length > 0) ||
          !Number.isSafeInteger(row.filter_revision) ||
          row.filter_revision <= 0
        )
          throw new Error("Invalid stored boundary.");
        const raw: unknown = JSON.parse(row.policies);
        if (!Array.isArray(raw) || raw.length > 256) throw new Error("Invalid stored policies.");
        const policies = decodeStoredScopePolicies(raw);
        if (
          policies.some(
            (policy) =>
              typeof policy.audience !== "object" || policy.audience.capability !== row.capability,
          ) ||
          policies.reduce(
            (sum, policy) =>
              sum +
              policy.rules.reduce(
                (n, rule) =>
                  n +
                  rule.match.reduce(
                    (count, ref) =>
                      count + (ref.kind === "participant" ? ref.identifiers.length : 1),
                    0,
                  ),
                0,
              ),
            0,
          ) > 256
        )
          throw new Error("Invalid stored policies.");
        empty = policies.length === 0;
        legacy = conservativeSources({
          sourceMode: row.source_mode,
          sourceIds: ids,
          scopePolicies: policies,
        });
        // Mark only understood policy data, never reinterpret an unsupported future contract.
        marked = JSON.stringify(encodeStoredScopePolicies(policies));
      } catch {
        // The current reader also refuses this overlay. Older readers must deny its entire capability.
      }
      if (marked !== undefined && marked !== row.policies)
        db.prepare("UPDATE access_scope_capabilities SET policies=? WHERE rowid=?").run(
          marked,
          row.rowid,
        );
      const table =
        row.owner_kind === "level" ? "access_level_capabilities" : "access_grant_capabilities";
      const key = row.owner_kind === "level" ? "level_id" : "grant_id";
      const quarantined = isScopeQuarantined(db, row.owner_kind, row.owner_id, row.capability);
      if (empty && !quarantined) {
        cursor = row.rowid;
        continue;
      }
      const actual = db
        .prepare<[string, string], { source_mode: string; source_ids: string }>(
          `SELECT source_mode,source_ids FROM ${table} WHERE ${key}=? AND capability=?`,
        )
        .get(row.owner_id, row.capability);
      let narrowed = !actual;
      if (actual) {
        try {
          const ids: unknown = JSON.parse(actual.source_ids);
          if (
            !Array.isArray(ids) ||
            !ids.every((id) => typeof id === "string") ||
            !["all", "allowlist", "denylist"].includes(actual.source_mode)
          )
            throw new Error("Invalid legacy boundary");
          const allows = (id: string) =>
            actual.source_mode === "all" ||
            (actual.source_mode === "allowlist" ? ids.includes(id) : !ids.includes(id));
          narrowed =
            legacy.sourceMode === "allowlist"
              ? legacy.sourceIds.some((id) => !allows(id))
              : actual.source_mode === "allowlist" ||
                (actual.source_mode === "denylist" &&
                  ids.some((id) => !legacy.sourceIds.includes(id)));
        } catch {
          narrowed = true;
        }
      }
      if (marked === undefined || quarantined || narrowed) {
        quarantineScopeAuthority(
          db,
          row.owner_kind,
          row.owner_id,
          row.capability,
          bumped,
          (owner, id, work) => withScopePolicyMutation(db, owner, id, work),
        );
      } else {
        withScopePolicyMutation(db, row.owner_kind, row.owner_id, () =>
          db
            .prepare(
              `UPDATE ${table} SET source_mode=?,source_ids=? WHERE ${key}=? AND capability=?`,
            )
            .run(legacy.sourceMode, JSON.stringify(legacy.sourceIds), row.owner_id, row.capability),
        );
      }
      cursor = row.rowid;
    }
  }
}
