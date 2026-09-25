// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { gatewayJson } from "../utils.js";
import type { GetSiblings } from "@omnesis/eval";

/**
 * Build a `GetSiblings` callback that POSTs to
 * `/documents/content-hash-siblings`. Used by `omnesis eval doctor` and
 * `omnesis eval run` to auto-expand expected-doc groups with their
 * byte-identical siblings, mirroring the search pipeline's
 * `dedupeByContentHash`.
 *
 * The endpoint contract is: each input docId always appears in its own
 * sibling list (regardless of whether it's been indexed yet) — so the
 * returned `Map` always contains a key for every input id, satisfying
 * the `GetSiblings` contract documented in `@omnesis/eval/resolver.ts`.
 */
export function buildContentHashSiblingsResolver(): GetSiblings {
  return async (ids: readonly string[]) => {
    if (ids.length === 0) return new Map();
    const { siblings } = await gatewayJson<{ siblings: Record<string, string[]> }>(
      "/documents/content-hash-siblings",
      { method: "POST", body: JSON.stringify({ documentIds: ids }) },
    );
    return new Map(Object.entries(siblings));
  };
}
