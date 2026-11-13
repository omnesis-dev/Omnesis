// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KNOWLEDGE_READ_SOURCE_IDS } from "../agent/knowledge-read-policy.js";
import { permittedSourceIds } from "./permitted-sources.js";
import { documentAccessInclusionSql, type DocumentAccessGrant } from "./filter-decision.js";
import type { FilterSql } from "./filter-sql.js";
import type { CorpusAuthorization } from "./corpus-authorization.js";
import type { Db } from "../data/types.js";

/**
 * What an external agent's authorization lets it read, in the form the
 * filter decision takes: the accounts it shares and its filters. Sources the
 * gateway writes itself are out of every filtered grant, since they can quote
 * what a filter withholds.
 */
export function documentAccessGrant(
  db: Db,
  authorization: CorpusAuthorization,
): DocumentAccessGrant {
  return {
    capabilityGranted: true,
    permittedSourceIds: permittedSourceIds(db, authorization),
    filters: authorization.scopePolicies,
    internalSourceIds: KNOWLEDGE_READ_SOURCE_IDS,
  };
}

/** A trusted SQL predicate on a document query using the outer alias `d`. */
export function authorizedDocumentInclusionSql(
  db: Db,
  authorization: CorpusAuthorization,
  options: { fewRecords?: boolean } = {},
): FilterSql {
  return documentAccessInclusionSql(
    db,
    documentAccessGrant(db, authorization),
    "d.id",
    "d.source_id",
    { row: "d", ...options },
  );
}
