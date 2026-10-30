// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/** Preserve historical uncertainty: a legacy user role does not identify its author. */
export function addConversationAuthors(db: Db): void {
  const columns = db.prepare<[], { name: string }>("PRAGMA table_info(agent_messages)").all();
  if (columns.length > 0 && !columns.some((column) => column.name === "author_json")) {
    db.exec("ALTER TABLE agent_messages ADD COLUMN author_json TEXT");
  }
  // No ledger rewrite is needed. Boot reconciliation renders every pushed day
  // with the current renderer; legacy user turns acquire unknown attribution.
}
