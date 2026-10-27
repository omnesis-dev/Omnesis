// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { conversationEvidencePolicy } from "./omnesis-chat/evidence-projection.js";
import type Database from "better-sqlite3";

/** Source-owned policies; shared consumers never infer roles from source text. */
const policies = [conversationEvidencePolicy] as const;
export interface SourceEvidenceAuthority {
  policy: "attributed_utterances";
  available: boolean;
  utterances: Array<{ role: "user" | "assistant"; start: number; end: number }>;
}

export function readSourceEvidenceAuthority(
  db: Database.Database,
  id: string,
  content: string,
): SourceEvidenceAuthority | undefined {
  const selected = sourceEvidencePolicy(db, id);
  if (!selected) return undefined;
  const { policy, providerMatches } = selected;
  const projection = providerMatches ? policy.read(db, id, content) : null;
  return {
    policy: "attributed_utterances",
    available: projection !== null,
    utterances: projection?.utterances ?? [],
  };
}

export function sourceRequiresEvidenceProjection(db: Database.Database, id: string): boolean {
  return sourceEvidencePolicy(db, id) !== undefined;
}
function sourceEvidencePolicy(db: Database.Database, id: string) {
  const columns = db.prepare<[], { name: string }>("PRAGMA table_info(documents)").all();
  if (!columns.some((c) => c.name === "source_id")) return undefined;
  const row = db
    .prepare<[string], { source_id: string; provider_id: string }>(
      `SELECT source_id,${columns.some((c) => c.name === "provider_id") ? "provider_id" : "NULL AS provider_id"} FROM documents WHERE id=?`,
    )
    .get(id);
  if (!row) return undefined;
  const policy = policies.find((p) => p.sourceId === row.source_id);
  if (!policy) return undefined;
  return { policy, providerMatches: row.provider_id === policy.providerId };
}

/** The entire utterance must have been observed. Partial reads cannot borrow
 * unseen user testimony or erase a qualifier from the same speech unit. */
export function attributedSourceStatements(
  authority: SourceEvidenceAuthority,
  content: string,
  observed: readonly { offset: number; length: number }[],
): Array<{ text: string; wholeStatementOnly: true }> {
  if (!authority.available) return [];
  return authority.utterances
    .filter(
      (u) =>
        u.end - u.start <= 1600 &&
        observed.some((span) => span.offset <= u.start && span.offset + span.length >= u.end),
    )
    .map((u) => ({
      text: `The recorded ${u.role} utterance was ${JSON.stringify(content.slice(u.start, u.end))}. This establishes what the ${u.role} said in this conversation, not independent confirmation of the utterance's world claims.`,
      wholeStatementOnly: true as const,
    }))
    .filter((statement) => statement.text.length <= 2048)
    .slice(0, 16);
}
