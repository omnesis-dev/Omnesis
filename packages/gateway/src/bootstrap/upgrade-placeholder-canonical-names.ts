// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { isPlaceholderPersonName } from "@omnesis/core";

/**
 * One-shot boot data fix for placeholder canonical names.
 *
 * Some people carry a phone/email-shaped `canonical_name` (the display
 * headline) even though a trusted real name already sits among their `name`
 * aliases. This arises when a person is first seen through a mention carrying
 * only an identifier — an iMessage / WhatsApp processed before the matching
 * contact card — so the headline falls back to the phone or email while the
 * real name lands later as a `name` alias.
 *
 * `findOrCreatePerson` promotes a trusted name onto a placeholder headline
 * whenever a matching mention resolves, and the boot contacts seed pushes
 * every contact card back through that path, so contact-matched people are
 * healed there. This pass covers the remainder: people whose only trusted
 * name came from a non-contact source (a message sender display name) and
 * whose documents are already resolved, so nothing re-runs resolution for
 * them.
 *
 * For every canonical person whose headline is still a placeholder
 * (phone/email-shaped or "Unknown") and which owns a trusted `name` alias,
 * promote the best such alias to `canonical_name`. Trusted-ness is implicit:
 * `name` aliases are only ever written for trusted roles, so any `name` alias
 * present is one we'd trust. When several exist, prefer a contact-card name
 * (an alias minted by a source that produces `documentType='contact'`
 * documents — the most authoritative display name), then the earliest, then
 * lexicographically, for a deterministic, source-agnostic choice.
 *
 * Idempotent: a promoted headline is no longer a placeholder, so subsequent
 * boots skip it; people with no trusted name alias are left untouched.
 */
export function upgradePlaceholderCanonicalNames(db: Db): { upgraded: number } {
  // Source ids that have produced at least one contact-card document. A
  // `name` alias minted by one of these is a contact-card name. Computed
  // generically from `documentType` rather than any hardcoded source name.
  const contactSourceIds = new Set(
    db
      .prepare<[], { source_id: string }>(
        `SELECT DISTINCT source_id FROM documents
         WHERE json_extract(metadata, '$.documentType') = 'contact'`,
      )
      .all()
      .map((r) => r.source_id),
  );

  // Candidate canonicals: the shape check can't run in SQL, so scan the
  // (small) people table and filter in JS. Only canonicals are displayed, so
  // only they are worth healing.
  const candidates = db
    .prepare<[], { id: string; canonical_name: string }>(
      "SELECT id, canonical_name FROM people WHERE merged_into IS NULL",
    )
    .all()
    .filter((p) => isPlaceholderPersonName(p.canonical_name));

  if (candidates.length === 0) return { upgraded: 0 };

  // Walk a canonical's full equivalence class downward via `merged_into`. A
  // visited Set bounds the walk against (illegal but defensive) cycles and
  // collapses diamonds — the same idiom `pruneNoreplyAliases` uses. We
  // deliberately do NOT assume chains are pre-flattened to a single hop:
  // `consolidateIntoSelf` (run earlier this boot by `seedFromContacts`) can
  // transiently deepen a chain into A→B→canonical before the periodic
  // transitive-collapse re-flattens it, and a deep loser's `name` alias is
  // exactly what we may need to promote.
  const childrenStmt = db.prepare<[string], { id: string }>(
    "SELECT id FROM people WHERE merged_into = ?",
  );
  const classMemberIds = (canonicalId: string): string[] => {
    const seen = new Set<string>([canonicalId]);
    const queue = [canonicalId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const child of childrenStmt.all(id)) {
        if (!seen.has(child.id)) {
          seen.add(child.id);
          queue.push(child.id);
        }
      }
    }
    return [...seen];
  };

  const nameAliasStmt = db.prepare<
    [string],
    { alias: string; source_id: string | null; created_at: string }
  >(
    "SELECT alias, source_id, created_at FROM person_aliases WHERE person_id = ? AND alias_type = 'name'",
  );
  const updateStmt = db.prepare(
    "UPDATE people SET canonical_name = ?, updated_at = ? WHERE id = ?",
  );

  const txn = db.transaction(() => {
    let upgraded = 0;
    const now = new Date().toISOString();
    for (const person of candidates) {
      const names = classMemberIds(person.id)
        .flatMap((id) => nameAliasStmt.all(id))
        // A `name` alias should never itself be placeholder-shaped, but guard
        // so a stray phone-as-name can't merely replace a phone headline.
        .filter((a) => !isPlaceholderPersonName(a.alias));
      if (names.length === 0) continue;

      names.sort((a, b) => {
        const aContact = a.source_id && contactSourceIds.has(a.source_id) ? 0 : 1;
        const bContact = b.source_id && contactSourceIds.has(b.source_id) ? 0 : 1;
        if (aContact !== bContact) return aContact - bContact;
        const byDate = a.created_at.localeCompare(b.created_at);
        if (byDate !== 0) return byDate;
        return a.alias.localeCompare(b.alias);
      });

      const best = names[0].alias;
      if (best === person.canonical_name) continue;
      updateStmt.run(best, now, person.id);
      upgraded++;
    }
    // No dirty marks: `canonical_name` is a pure display field. The promoted
    // value was already a `name` alias (the precondition for promotion), so
    // merge-candidate detection (which reads name tokens from `person_aliases`
    // only) and every other derived structure are unaffected.
    return upgraded;
  });

  return { upgraded: txn() };
}
