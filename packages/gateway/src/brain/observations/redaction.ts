// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keeping a deleted source out of the Morning brief conversation.
 *
 * Deleting a document deletes the observations that cite it, but a brief
 * already sent may have quoted them. Each pass finds those briefs and
 * replaces their text with a notice, then forgets their items so the brief
 * is redacted once.
 */

import { listTaintedMorningBriefs } from "../storage/morning-brief-items.js";
import type { Logger } from "@omnesis/core";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

export interface MorningBriefRedactionDeps {
  db: Database.Database;
  writeGate: Pick<WriteGate, "clearMorningBriefMessageItems">;
  /** The conversation side; null while the agent service is not running. */
  getConversations: () => {
    redactMorningBrief(conversationId: string, messageId: string): Promise<boolean>;
  } | null;
  log: Logger;
}

/** Redact every tainted brief; returns how many were handled. */
export async function redactTaintedMorningBriefs(deps: MorningBriefRedactionDeps): Promise<number> {
  const tainted = listTaintedMorningBriefs(deps.db);
  if (tainted.length === 0) return 0;
  const conversations = deps.getConversations();
  if (!conversations) return 0;
  let handled = 0;
  for (const brief of tainted) {
    try {
      // A brief no longer in the thread has nothing left to redact.
      await conversations.redactMorningBrief(brief.conversationId, brief.messageId);
      await deps.writeGate.clearMorningBriefMessageItems(brief.messageId);
      handled += 1;
    } catch (err) {
      // A turn in progress: the next pass redacts it.
      deps.log.warn(
        `could not redact brief ${brief.messageId} yet: ${(err as Error).message ?? err}`,
      );
    }
  }
  return handled;
}
