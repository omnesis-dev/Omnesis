// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { contextualEvidence } from "./verification-evidence.js";

export const ANNOTATION_CONTEXT_VERIFIER = "annotation-context-verifier-v3";

/** Interpretation only; adds no factual evidence or authority to the note. */
export function annotationVerificationContext(
  kind: "doc_annotation" | "person_annotation",
  enclosingContext?: unknown,
): string {
  return JSON.stringify({
    kind: kind === "doc_annotation" ? "document annotation" : "person annotation",
    interpretation:
      enclosingContext === undefined
        ? "A synthesized factual note; no additional factual context is supplied."
        : "Assess only the selected claim in the complete note and enclosing semantics. These constrain its interpretation but are not additional factual evidence.",
    ...(enclosingContext === undefined ? {} : { enclosingContext }),
  });
}

/** Caller validates source access and quote membership before constructing this frame. */
export function annotationEvidenceFrame(
  atoms: readonly { quote: string; source: string }[],
): string {
  return JSON.stringify({
    sources: atoms.map(({ quote, source }) => {
      const frame = contextualEvidence(quote, source);
      const context =
        frame === quote
          ? { source_context: source, truncated: false }
          : (JSON.parse(frame) as { source_context: string; truncated: boolean });
      return {
        authority: "selected_quote",
        title: null,
        text: context.source_context,
        selectedQuotes: [quote],
        truncated: context.truncated,
      };
    }),
    verifiedReferences: [],
    limitation:
      "Selected quotes supply the asserted facts. Surrounding source text only qualifies their interpretation; omitted passages cannot establish absence.",
  });
}
