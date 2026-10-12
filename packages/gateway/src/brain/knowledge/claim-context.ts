// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Marked } from "marked";
import { parseClaimMarkup, type ParsedClaimMarkup } from "./claims.js";
import {
  KnowledgeStorageError,
  type KnowledgeClaimState,
  type SaveKnowledgeNodeInput,
} from "./types.js";

export const CONTEXTUAL_VERIFIER = "contextual-entailment-verifier-v5";

/** These kinds require placement-aware proof, including their selected-reference reads. */
export function requiresContextualProof(kind: string): boolean {
  return kind === "wiki" || kind === "root" || kind === "loop";
}

export interface KnowledgeClaimContext {
  pageTitle: string;
  sectionPaths: string[][];
  enclosingClaims: string[];
  enclosingSemantics: Omit<KnowledgeClaimState, "verification">[];
  /** Full note is interpretation only; this span identifies the assertion being judged. */
  annotation?: { text: string; selectedSpan: { start: number; end: number } };
  /** Final outcome prose only constrains the selected assertion; it is not evidence. */
  outcome?: { text: string; selectedSpan: { start: number; end: number } };
}

/** Keep attribution visible when an exact claim is read as supporting prose. */
export function contextualKnowledgeClaim(text: string, context?: KnowledgeClaimContext): string {
  if (!context) return text;
  return JSON.stringify({
    claim: text,
    context,
    contextRole:
      "Interpretation constraints on this claim, not independently established assertions. Do not extract additional facts from placement context alone.",
  });
}

/** One bounded Markdown parse per page; quoted/fenced headings are not page scope. */
export function knowledgeClaimContexts(
  input: Pick<SaveKnowledgeNodeInput, "kind" | "title" | "markdown" | "claims">,
  parsed: ParsedClaimMarkup = parseClaimMarkup(input.markdown),
): Map<string, KnowledgeClaimContext> {
  const contexts = new Map<string, KnowledgeClaimContext>();
  const annotation = input.kind === "doc_annotation" || input.kind === "person_annotation";
  if (!requiresContextualProof(input.kind) && !annotation) return contexts;
  // Marked normalizes line endings. Keep a single offset map for claim boundaries.
  const positions = new Uint32Array(parsed.text.length + 1);
  let normalized = "";
  for (let index = 0; index < parsed.text.length; index++) {
    positions[index] = normalized.length;
    if (parsed.text[index] === "\r") {
      normalized += "\n";
      if (parsed.text[index + 1] === "\n") positions[++index] = normalized.length - 1;
    } else normalized += parsed.text[index];
  }
  positions[parsed.text.length] = normalized.length;
  const headings: { start: number; path: string[] }[] = [];
  const stack: { depth: number; text: string }[] = [];
  let offset = 0;
  for (const token of new Marked().lexer(normalized)) {
    if (token.type === "heading") {
      while (stack.length && stack.at(-1)!.depth >= token.depth) stack.pop();
      stack.push({ depth: token.depth, text: token.text });
      headings.push({ start: offset, path: stack.map((entry) => entry.text) });
    }
    offset += token.raw.length;
  }
  const claims = new Map(parsed.claims.map((claim) => [claim.id, claim]));
  const states = new Map(input.claims?.map((state) => [state.id, state]));
  for (const claim of parsed.claims) {
    const start =
      positions[claim.textSpan.start]! +
      (claim.text.match(/^\s*/)?.[0].replace(/\r\n|\r/g, "\n").length ?? 0);
    const end = positions[claim.textSpan.end]!;
    const paths: string[][] = [];
    let initial: string[] = [];
    let low = 0;
    let high = headings.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (headings[middle]!.start <= start) low = middle + 1;
      else high = middle;
    }
    if (low > 0) initial = headings[low - 1]!.path;
    for (let index = low; index < headings.length && headings[index]!.start < end; index++)
      paths.push(headings[index]!.path);
    const enclosingClaims: string[] = [];
    const enclosingSemantics: KnowledgeClaimContext["enclosingSemantics"] = [];
    let parent = claim.parentId ? claims.get(claim.parentId) : undefined;
    while (parent) {
      const state = states.get(parent.id);
      enclosingSemantics.unshift({
        id: parent.id,
        relations: Object.fromEntries(
          [...parent.refs]
            .sort((a, b) => a.raw.localeCompare(b.raw))
            .map((ref) => [ref.raw, state?.relations?.[ref.raw] ?? "supports"]),
        ),
        supportLogic: state?.supportLogic ?? "all",
        validFrom: state?.validFrom ?? null,
        validUntil: state?.validUntil ?? null,
        attribution: state?.attribution ?? null,
        modality: state?.modality ?? "observation",
        epistemicStatus: state?.epistemicStatus ?? "asserted",
      });
      enclosingClaims.unshift(
        parsed.text.slice(parent.textSpan.start, claim.textSpan.start) +
          "[selected claim]" +
          parsed.text.slice(claim.textSpan.end, parent.textSpan.end),
      );
      parent = parent.parentId ? claims.get(parent.parentId) : undefined;
    }
    const context = {
      pageTitle: annotation ? "" : input.title,
      sectionPaths: [initial, ...paths],
      enclosingClaims,
      enclosingSemantics,
      ...(annotation ? { annotation: { text: parsed.text, selectedSpan: claim.textSpan } } : {}),
      ...(input.kind === "loop"
        ? { outcome: { text: parsed.text, selectedSpan: claim.textSpan } }
        : {}),
    };
    if (JSON.stringify(context).length > 16_384)
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Claim placement context exceeds 16384 characters; split the claim or simplify its enclosing structure",
      );
    contexts.set(claim.id, context);
  }
  return contexts;
}
