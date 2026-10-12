// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { briefEvidenceContext } from "../brief-evidence-context.js";
import { captureOutcomeWriteFence } from "../storage/outcome-write-fence.js";
import { assertKnowledgeDependencyVersion } from "./storage-validation.js";
import { historicalBriefFields } from "./owner-maintenance.js";
import type { KnowledgeOwnerSnapshot } from "./owner-adapters.js";
import type { ParsedClaimMarkup } from "./claims.js";
import type { SaveKnowledgeNodeInput, KnowledgeClaimState } from "./types.js";
import type Database from "better-sqlite3";

/** Capture the proposed display and its evidence together, before any model await. */
export function prepareKnowledgeBriefCheck(
  db: Database.Database,
  input: Pick<SaveKnowledgeNodeInput, "title" | "inputVersions">,
  parsed: ParsedClaimMarkup,
  owner: KnowledgeOwnerSnapshot | null,
  now: number,
  states: ReadonlyMap<string, KnowledgeClaimState>,
  reference: (ref: string) => {
    revision: import("./types.js").KnowledgeRevision;
    verified: boolean;
    stale: boolean;
    text: string;
    verifierEvidence?: string;
  },
) {
  if (owner?.kind !== "brief") return null;
  // Immutable historical prose can receive proof maintenance without paying
  // another full-display check. The owner writer still forbids prose changes.
  if (
    historicalBriefFields(owner.canonicalFields, now) &&
    input.title === owner.title &&
    parsed.text === owner.markdown
  )
    return null;
  return db.transaction(() => {
    const sourceIds = new Set(owner.evidenceDocumentIds);
    const additional = new Map<string, string>();
    for (const claim of parsed.claims) {
      for (const ref of claim.refs) {
        const view = reference(ref.raw);
        assertKnowledgeDependencyVersion(input.inputVersions, ref.raw, view.revision);
        if ((states.get(claim.id)?.relations?.[ref.raw] ?? "supports") !== "supports") continue;
        if (ref.kind === "source") sourceIds.add(ref.id);
        else if (view.verified && !view.stale)
          additional.set(ref.raw, view.verifierEvidence ?? view.text);
      }
    }
    const payload = briefEvidenceContext(
      db,
      {
        title: input.title,
        body: parsed.text,
        eventAt:
          typeof owner.canonicalFields.eventAt === "number" ? owner.canonicalFields.eventAt : null,
        relevantUntil:
          typeof owner.canonicalFields.relevantUntil === "number"
            ? owner.canonicalFields.relevantUntil
            : null,
      },
      [...sourceIds],
      now,
      [],
      [...additional].map(([ref, text]) => ({ ref, text })),
    );
    return payload
      ? {
          payload,
          fence: captureOutcomeWriteFence(db, owner.id, [...sourceIds], "brief"),
        }
      : null;
  })();
}
