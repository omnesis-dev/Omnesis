// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KnowledgeStorageError } from "./types.js";

export type ClaimReferenceKind = "source" | "wiki" | "loop" | "annotation" | "brief";
export type ClaimSelectorKind = "evidence" | "claim" | "field";

export interface ClaimReference {
  raw: string;
  kind: ClaimReferenceKind;
  id: string;
  selector?: { kind: ClaimSelectorKind; id: string };
}

/** Opaque identifiers, never URLs, paths, markup, or encoded attribute values. */
export function isClaimIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);
}

const REFERENCE_SYNTAX_GUIDANCE =
  "Use source:<documentId> for a whole fetched document; doc: and document: are not reference kinds. Whole-node forms are wiki:<pageId>, loop:<loopId>, annotation:<annotationId>, and brief:<briefId>. Selectors are source:<documentId>#evidence:<evidenceId>, wiki|loop|annotation|brief:<id>#claim:<claimId>, or loop:<loopId>#field:<fieldName>. Replace placeholders with exact IDs returned by tools; identifiers use 1–128 letters, digits, underscores or hyphens.";

function invalidReferenceSyntax(message: string): KnowledgeStorageError {
  // Syntax guidance is independent of whether an ID exists or is privacy-hidden.
  return new KnowledgeStorageError("reference_invalid", `${message}. ${REFERENCE_SYNTAX_GUIDANCE}`);
}

/** Syntax only: existence, revisions and entailment belong to the write service. */
export function parseClaimReference(raw: string): ClaimReference {
  const match =
    /^(source|wiki|loop|annotation|brief):([A-Za-z0-9_-]{1,128})(?:#(evidence|claim|field):([A-Za-z0-9_-]{1,128}))?$/.exec(
      raw,
    );
  if (!match || match[0] !== raw) throw invalidReferenceSyntax("Invalid claim reference syntax");
  const kind = match[1] as ClaimReferenceKind;
  const id = match[2]!;
  const selectorKind = match[3] as ClaimSelectorKind | undefined;
  if (selectorKind) {
    const allowed =
      kind === "source"
        ? selectorKind === "evidence"
        : kind === "loop"
          ? selectorKind === "field" || selectorKind === "claim"
          : selectorKind === "claim";
    if (!allowed) throw invalidReferenceSyntax("Invalid selector for claim reference kind");
    return { raw, kind, id, selector: { kind: selectorKind, id: match[4]! } };
  }
  return { raw, kind, id };
}

/** Echo only the caller's validated reference, never the reason it is hidden. */
export function unavailableKnowledgeReference(ref: ClaimReference): KnowledgeStorageError {
  return new KnowledgeStorageError(
    "reference_invalid",
    `Reference ${JSON.stringify(ref.raw)} is unavailable. Check the ID and selector against search or fetch results before retrying.`,
  );
}
