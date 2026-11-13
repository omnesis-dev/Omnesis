// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { personIdentifiers } from "@omnesis/types";
import type { SourceScopeConversationUpdate } from "@omnesis/types";

/** A producer's normal page budget; one larger native group travels alone. */
export const SOURCE_SCOPE_PAGE_WORK = 4096;
/** Wire safety ceiling, including one full large native group and its identifiers. */
export const SOURCE_SCOPE_MAX_PAGE_WORK = 16384;
export function conversationScopeWork(update: SourceScopeConversationUpdate): number {
  return update.participants.reduce((total, person) => {
    const ids = personIdentifiers(person);
    return total + 1 + ids.length + ids.filter((id) => id.kind === "email").length;
  }, 0);
}
