// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { MIN_VOCABULARY_DOCUMENTS } from "./types.js";

/**
 * Unmarked evidence means no source-declared automation marker, not a human
 * authorship claim. Preserve unknown legacy confidence until observations are
 * refreshed. Known automated support needs independent unmarked corroboration
 * before receiving the ordinary profile's full relevance weight.
 */
export function ordinaryEvidenceQuality(
  evidenceCount: number,
  ordinaryCount: number,
  machineWeight = 0.15,
): number {
  if (
    evidenceCount <= 0 ||
    evidenceCount <= ordinaryCount ||
    ordinaryCount >= MIN_VOCABULARY_DOCUMENTS
  )
    return 1;
  return machineWeight;
}
