// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/** Name of the index that finds a name alias regardless of case. */
export const PERSON_NAME_ALIAS_INDEX = "idx_person_aliases_name_lower";

/**
 * Index name aliases by their lowercased text.
 *
 * Names are matched without regard to case (`LOWER(alias) = ?`): a merge rule
 * stores its name lowercased, while people carry names as their sources wrote
 * them. The `(alias_type, alias)` index cannot serve that comparison, so every
 * name lookup walked every name alias in the store. The People → Rules page
 * resolves each active rule's winner this way, so a page load cost one such
 * walk per name-winner rule.
 *
 * The index is partial: only name aliases are compared this way, and leaving
 * emails, phones and chat ids out keeps it small and keeps their inserts from
 * maintaining it. A query can use it only when its filter includes
 * `alias_type = 'name'`, and without statistics the planner still prefers the
 * covering `(alias_type, alias)` index, so readers name it with `INDEXED BY`.
 */
export function indexPersonNameAliases(db: Db): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${PERSON_NAME_ALIAS_INDEX}
       ON person_aliases(LOWER(alias)) WHERE alias_type = 'name'`,
  );
}
