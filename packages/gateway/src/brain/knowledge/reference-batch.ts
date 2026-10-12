// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KnowledgeStorageError } from "./types.js";
import { ClaimMarkupError } from "./claims.js";
import type { KnowledgeReferenceView } from "./service.js";

export const KNOWLEDGE_REFERENCE_BATCH_BYTES = 64 * 1024 - 256;
export type ReferenceBatchItem =
  | { ok: true; value: KnowledgeReferenceView }
  | { ok: false; ref: string; code: string; message: string };

/** Only complete views returned within this budget may become read receipts. */
export function readKnowledgeReferenceBatch(
  refs: readonly string[],
  read: (ref: string) => KnowledgeReferenceView,
): { items: ReferenceBatchItem[]; deferredRefs: string[] } {
  const unique = [...new Set(refs)];
  const items: ReferenceBatchItem[] = [];
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  for (let i = 0; i < unique.length; i++) {
    const ref = unique[i]!;
    let item: ReferenceBatchItem;
    try {
      item = { ok: true, value: read(ref) };
    } catch (error) {
      if (!(error instanceof KnowledgeStorageError || error instanceof ClaimMarkupError))
        throw error;
      item = {
        ok: false,
        ref,
        code: error.code,
        message: "Reference unavailable or invalid; correct the exact reference before retrying.",
      };
    }
    if (
      bytes({ items: [item], deferredRefs: unique.filter((_, j) => j !== i) }) >
      KNOWLEDGE_REFERENCE_BATCH_BYTES
    )
      item = {
        ok: false,
        ref,
        code: "reference_too_large",
        message:
          "Read this reference separately with knowledge_reference({ref}); no content or read receipt was returned here.",
      };
    const deferredRefs = unique.slice(i + 1);
    if (bytes({ items: [...items, item], deferredRefs }) > KNOWLEDGE_REFERENCE_BATCH_BYTES)
      return { items, deferredRefs: unique.slice(i) };
    items.push(item);
  }
  return { items, deferredRefs: [] };
}
