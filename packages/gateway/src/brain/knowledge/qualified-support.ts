// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CONTEXTUAL_VERIFIER } from "./claim-context.js";
import { KnowledgeReferenceReader, selectedReferenceAuthority } from "./reference-reader.js";
import { getKnowledgeNode } from "./storage-read.js";
import type Database from "better-sqlite3";

/** A qualified statement; the optional symbol is host-only and never serialized. */
export interface QualifiedKnowledgeSupport {
  readonly [selectedReferenceAuthority]?: string;
  ref: string;
  revision: string | number;
  text: string;
  interpretationContext?: string;
}

/** Exact claim authority, independently of unrelated stale sibling assertions.
 * Callers retain their whole-page privacy and exact projection/read fences. */
export function readQualifiedKnowledgeSupport(
  db: Database.Database,
  nodeId: string,
  options: { capturedRefs?: readonly string[]; captureAuthority?: boolean } = {},
): { verifiedSupport: QualifiedKnowledgeSupport[]; truncated: boolean } {
  return db.transaction(() => {
    const node = getKnowledgeNode(db, nodeId);
    const verifiedSupport: QualifiedKnowledgeSupport[] = [];
    if (
      !node ||
      !["wiki", "root", "loop"].includes(node.kind) ||
      node.canonicalFields.withdrawn === true
    )
      return { verifiedSupport, truncated: false };
    if (
      options.capturedRefs &&
      (options.capturedRefs.length > 16 ||
        new Set(options.capturedRefs).size !== options.capturedRefs.length)
    )
      return { verifiedSupport, truncated: true };
    const prefix = node.kind === "loop" ? "loop" : "wiki";
    const claims = db
      .prepare<
        string[],
        {
          id: string;
          epistemic_status: string;
          modality: string;
          attribution: string | null;
          valid_from: number | null;
          valid_until: number | null;
        }
      >(
        `SELECT id,epistemic_status,modality,attribution,valid_from,valid_until
      FROM knowledge_claims WHERE node_id=? AND verification='verified'
      AND epistemic_status='asserted' AND verifier=?
      ${options.capturedRefs ? `AND id IN (SELECT value FROM json_each(?))` : ""}
      ORDER BY span_start,id LIMIT 17`,
      )
      .all(
        nodeId,
        CONTEXTUAL_VERIFIER,
        ...(options.capturedRefs
          ? [
              JSON.stringify(
                options.capturedRefs.map((ref) => {
                  const prefixRef = `${prefix}:${nodeId}#claim:`;
                  return ref.startsWith(prefixRef) ? ref.slice(prefixRef.length) : "";
                }),
              ),
            ]
          : []),
      );
    let truncated = claims.length > 16;
    let bytes = 0;
    const views = new KnowledgeReferenceReader(db, options.captureAuthority).references(
      claims.slice(0, 16).map((claim) => `${prefix}:${nodeId}#claim:${claim.id}`),
    );
    for (const view of views) {
      if (!view.verified || view.stale) continue;
      const claim = claims.find((claim) => view.ref === `${prefix}:${nodeId}#claim:${claim.id}`)!;
      const value = {
        ...(view[selectedReferenceAuthority]
          ? { [selectedReferenceAuthority]: view[selectedReferenceAuthority] }
          : {}),
        ref: view.ref,
        revision: view.revision,
        ...(view.interpretationContext
          ? { interpretationContext: JSON.stringify(view.interpretationContext) }
          : {}),
        text: JSON.stringify({
          statement: view.text,
          semantics: {
            epistemicStatus: claim.epistemic_status,
            modality: claim.modality,
            attribution: claim.attribution,
            validFrom: claim.valid_from,
            validUntil: claim.valid_until,
          },
        }),
      };
      const size = Buffer.byteLength(JSON.stringify(value));
      if (bytes + size > 16_384) {
        truncated = true;
        continue;
      }
      bytes += size;
      verifiedSupport.push(value);
    }
    // A bounded traversal may withhold a candidate without returning a view.
    if (views.length < Math.min(claims.length, 16)) truncated = true;
    return { verifiedSupport, truncated };
  })();
}
