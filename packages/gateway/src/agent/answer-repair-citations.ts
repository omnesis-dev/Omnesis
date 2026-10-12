// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isClaimIdentifier, parseClaimReference } from "../brain/knowledge/references.js";

export interface RepairPageCitationInput {
  documentId: string;
  nodeId?: string;
  kind?: string;
  verifiedSupport: ReadonlyArray<{ ref: string }>;
}

/** Repair-only navigation from already admitted complete Knowledge reads.
 * Neither these identifiers nor their relationships grant factual authority.
 */
export function repairPageCitations(inputs: readonly RepairPageCitationInput[]) {
  const result: {
    pages: Array<{ documentId: string; pageRef: string; supportedClaimRefs: string[] }>;
    incomplete: boolean;
  } = { pages: [], incomplete: inputs.length > 32 };
  const seen = new Set<string>();
  for (const input of inputs.slice(0, 32)) {
    if (input.verifiedSupport.length > 16) result.incomplete = true;
    if (
      !input.nodeId ||
      !isClaimIdentifier(input.nodeId) ||
      !isClaimIdentifier(input.documentId) ||
      !["wiki", "root"].includes(input.kind ?? "")
    )
      continue;
    const supportedClaimRefs: string[] = [];
    for (const support of input.verifiedSupport.slice(0, 16)) {
      try {
        const ref = parseClaimReference(support.ref);
        if (
          ref.kind === "wiki" &&
          ref.id === input.nodeId &&
          ref.selector?.kind === "claim" &&
          !supportedClaimRefs.includes(ref.raw)
        )
          supportedClaimRefs.push(ref.raw);
      } catch {
        // Invalid or foreign references never mint navigation handles.
      }
    }
    if (!supportedClaimRefs.length || seen.has(input.nodeId)) continue;
    const page = {
      documentId: input.documentId,
      pageRef: `wiki:${input.nodeId}`,
      supportedClaimRefs,
    };
    if (
      result.pages.length >= 32 ||
      Buffer.byteLength(JSON.stringify({ ...result, pages: [...result.pages, page] })) > 16_384
    ) {
      result.incomplete = true;
      break;
    }
    seen.add(input.nodeId);
    result.pages.push(page);
  }
  return result;
}
