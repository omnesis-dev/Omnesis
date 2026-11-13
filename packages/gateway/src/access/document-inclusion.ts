// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KNOWLEDGE_READ_SOURCE_IDS } from "../agent/knowledge-read-policy.js";
import { permittedSourceIds } from "./permitted-sources.js";
import { sourceScopeInclusionSql, type ScopeSql } from "./scope-sql.js";
import type { CorpusAuthorization } from "./corpus-authorization.js";
import type { Db } from "../data/types.js";

/** A trusted SQL predicate on a document query using the outer alias `d`. */
export function authorizedDocumentInclusionSql(
  db: Db,
  authorization: CorpusAuthorization,
): ScopeSql {
  const sources = permittedSourceIds(db, authorization);
  let scope = sourceScopeInclusionSql(authorization.scopePolicies, "d.id", "d.source_id");
  if (authorization.scopePolicies.length)
    scope = {
      sql: `(d.source_id NOT IN (SELECT value FROM json_each(?)) AND (${scope.sql}))`,
      params: [JSON.stringify(KNOWLEDGE_READ_SOURCE_IDS), ...scope.params],
    };
  return sources === null
    ? scope
    : {
        sql: `(d.source_id IN (SELECT value FROM json_each(?)) AND (${scope.sql}))`,
        params: [JSON.stringify([...sources]), ...scope.params],
      };
}
