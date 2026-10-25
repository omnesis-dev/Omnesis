// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseClaimReference } from "./references.js";
import { getKnowledgeNode } from "./storage.js";
import type { KnowledgeReferenceView } from "./reference-reader.js";
import type { KnowledgeNode, KnowledgeVerification } from "./types.js";
import type Database from "better-sqlite3";

const SAVE_FEEDBACK_CLAIMS = 64;
const SAVE_FEEDBACK_GUIDANCE =
  "Save acceptance and completed review work do not mean every claim is verified. These are stored verification states, not current support receipts. To ground an unverified assertion, read exact qualified claim references or original source evidence. Report unresolved verification honestly; do not retry unchanged proposals merely because verification is unavailable.";

/** Tool guidance only; neither changes reference authority nor grants a new receipt. */
export function referenceProofFeedback(view: KnowledgeReferenceView) {
  const ref = parseClaimReference(view.ref);
  if (ref.kind === "source" || ref.selector) return view;
  return {
    ...view,
    supportUsage: "orientation_only" as const,
    supportGuidance:
      "A whole synthesis reference supplies orientation, not verified factual support. Read its editing view and resolve exact #claim: selectors returned there, or read original source evidence. Only current qualified claims can support derived assertions; tracked state alone does not establish world state.",
  };
}

/** One privacy-fenced snapshot, bound to the accepted revision, with no proof re-evaluation. */
export function savedProofFeedback(db: Database.Database, accepted: KnowledgeNode) {
  return db.transaction(() => {
    const node = getKnowledgeNode(db, accepted.id);
    if (
      !node ||
      node.canonicalFields.withdrawn === true ||
      node.revision !== accepted.revision ||
      node.validity !== accepted.validity
    )
      return {
        status: "unavailable" as const,
        acceptedRevision: accepted.revision,
        guidance:
          "The saved revision's verification summary is unavailable; read the current node before describing its proof status.",
      };
    const rows = db
      .prepare<
        [string, number],
        { id: string; storedVerification: KnowledgeVerification }
      >("SELECT id,verification AS storedVerification FROM knowledge_claims WHERE node_id=? ORDER BY id LIMIT ?")
      .all(node.id, SAVE_FEEDBACK_CLAIMS + 1);
    return {
      status: "available" as const,
      acceptedRevision: node.revision,
      claims: rows.slice(0, SAVE_FEEDBACK_CLAIMS),
      truncated: rows.length > SAVE_FEEDBACK_CLAIMS,
      guidance: SAVE_FEEDBACK_GUIDANCE,
    };
  })();
}
