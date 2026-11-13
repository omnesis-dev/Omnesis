// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Self-memory resolution — the durable profile of the user, injected into an
 * agent run's context so it need not re-derive who the user is.
 *
 * The user is a person like any other: their roles, standing preferences, and
 * life-context are `person_annotations` on the self person, grounded and
 * lifecycled the same way. This resolves the injectable block from those
 * annotations, behind the feature gate. Shared by the background Brain
 * (gated on `annotations.enabled`) and authorized interactive agents in every
 * gateway mode, so both surfaces compute it identically.
 */

import { fetchSelfPersonId } from "../domain/InteractionScoreService.js";
import { authorizedDocumentInclusionSql } from "../access/document-inclusion.js";
import {
  listLivePersonAnnotationsForPerson,
  renderSelfMemoryBlock,
  DEFAULT_SELF_MEMORY_MAX_ANNOTATIONS,
} from "./storage/person-annotations.js";
import type { CorpusAuthorization } from "../access/corpus-authorization.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface ResolvedSelfMemory {
  /** The self person's id when identified + the feature is on, else null. */
  selfPersonId: string | null;
  /**
   * The rendered self-memory block (the self person's capped live annotations),
   * or "" when the feature is off, self is unidentified, or there are none.
   */
  selfMemory: string;
  /**
   * The ids of the person annotations the block renders — the consumption-
   * provenance seed (an injected self-memory fact counts as a prior every
   * run consumed). Empty whenever `selfMemory` is empty.
   */
  annotationIds: readonly string[];
  /** Complete grounding read-set for a filtered external prompt. */
  evidenceDocumentIds?: readonly string[];
}

/**
 * Resolve the injectable self-memory. Returns empty (no id, no block) when
 * `enabled` is false — so a caller behind a feature gate passes the gate here
 * and never touches the store when off. `selfPersonId` is surfaced so the
 * background agent can `annotate_person` durable user-facts onto it.
 */
export function resolveSelfMemory(
  db: Db,
  enabled: boolean,
  authorization?: CorpusAuthorization,
): ResolvedSelfMemory {
  return db.transaction(() => {
    const selfPersonId = enabled ? fetchSelfPersonId(db) : null;
    const annotations = selfPersonId
      ? listLivePersonAnnotationsForPerson(db, selfPersonId, {
          limit: DEFAULT_SELF_MEMORY_MAX_ANNOTATIONS,
          ...(authorization
            ? { evidenceInclusion: authorizedDocumentInclusionSql(db, authorization) }
            : {}),
        })
      : [];
    const evidenceDocumentIds = authorization?.scopePolicies.length
      ? db
          .prepare<[string, string], { evidence_doc_id: string }>(
            `
    SELECT evidence_doc_id FROM person_annotations WHERE id IN (SELECT value FROM json_each(?))
    UNION SELECT evidence_doc_id FROM person_annotation_evidence
    WHERE annotation_id IN (SELECT value FROM json_each(?)) AND broken_at IS NULL
  `,
          )
          .all(
            JSON.stringify(annotations.map((a) => a.id)),
            JSON.stringify(annotations.map((a) => a.id)),
          )
          .map((row) => row.evidence_doc_id)
      : undefined;
    return {
      selfPersonId,
      selfMemory: renderSelfMemoryBlock(annotations),
      annotationIds: annotations.map((a) => a.id),
      ...(evidenceDocumentIds ? { evidenceDocumentIds } : {}),
    };
  })();
}
