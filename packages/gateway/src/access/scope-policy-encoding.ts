// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { canonicalScopePolicies, scopePolicyV1Schema } from "./scope-policy.js";
import type { ScopePolicy } from "@omnesis/types";
import type { Db } from "../data/types.js";

/** Storage semantics include mutable native epochs, hierarchy fences and trusted Answer provenance. */
export const SCOPE_POLICY_STORAGE_PROTOCOL = 2;
export type StoredScopePolicy = ScopePolicy & { minimumProtocol: 2 };

export function encodeStoredScopePolicies(policies: readonly ScopePolicy[]): StoredScopePolicy[] {
  return canonicalScopePolicies(policies).map((policy) => ({
    ...policy,
    minimumProtocol: SCOPE_POLICY_STORAGE_PROTOCOL,
  }));
}

/** Public V1 policies remain strict; the protocol marker is understood only at persistence boundaries. */
export function decodeStoredScopePolicies(value: unknown): ScopePolicy[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("Invalid stored scope policies.");
  let budget = 0;
  return canonicalScopePolicies(
    value.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error("Invalid stored scope policy.");
      const { minimumProtocol, ...policy } = item;
      if (minimumProtocol !== undefined && minimumProtocol !== SCOPE_POLICY_STORAGE_PROTOCOL)
        throw new Error("Unsupported scope policy storage protocol.");
      const parsed = scopePolicyV1Schema.parse(policy);
      budget += parsed.rules.reduce(
        (sum, rule) =>
          sum +
          rule.match.reduce(
            (count, ref) => count + (ref.kind === "participant" ? ref.identifiers.length : 1),
            0,
          ),
        0,
      );
      if (budget > 256) throw new Error("Stored scope policies exceed the V1 bound.");
      return parsed;
    }),
  );
}

/** Boot migration visits capability settings only, never growing task, document or fact history. */
export function upgradeScopePolicyEncodingV2(db: Db): void {
  let cursor = 0;
  for (;;) {
    const rows = db
      .prepare<[number], { rowid: number; policies: string }>(
        "SELECT rowid,policies FROM access_scope_capabilities WHERE rowid>? ORDER BY rowid LIMIT 100",
      )
      .all(cursor);
    if (!rows.length) break;
    for (const row of rows) {
      const policies = decodeStoredScopePolicies(JSON.parse(row.policies));
      if (policies.length)
        db.prepare("UPDATE access_scope_capabilities SET policies=? WHERE rowid=?").run(
          JSON.stringify(encodeStoredScopePolicies(policies)),
          row.rowid,
        );
      cursor = row.rowid;
    }
  }
}
