// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scopeSatisfies, SCOPE_READ, type Scope } from "@omnesis/types";

/** Audio contribution alone does not authorize corpus-derived hint disclosure. */
export function transcriptionVocabularyAllowed(scopes: readonly Scope[]): boolean {
  return scopeSatisfies(scopes, SCOPE_READ);
}
