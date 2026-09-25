// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { createLogger, isNonIdentifyingEmail, normalizeEmail } from "@omnesis/core";
import { markPeopleGraphDirty, markMergeRulesDirty } from "../data/DirtyMarks.js";

const log = createLogger("gateway:people");

/**
 * Default distinct `name`-alias count at which a single-email person bucket
 * is treated as a shared / firehose address and demoted. No real person has
 * this many distinct cleaned name spellings; a shared mailbox (a ticket
 * queue, a notification relay) accretes one per author.
 */
export const DEFAULT_SHARED_ADDRESS_NAME_THRESHOLD = 15;

/**
 * Default upper bound on distinct `email` aliases for a bucket to qualify as
 * a single shared address. The defining shape is "one mailbox, many senders";
 * a legitimately well-merged hub person tends to carry several emails AND
 * few names, so this cheaply excludes them on top of the name threshold.
 */
export const DEFAULT_SHARED_ADDRESS_MAX_EMAILS = 5;

export interface DemoteSharedAddressesResult {
  /** Number of person buckets deleted. */
  demoted: number;
  /** Number of email addresses added to / refreshed in the learned blocklist. */
  emailsBlocked: number;
}

/**
 * Detect and demote "shared address" people — a person bucket keyed on a
 * single ordinary-looking email that has accreted a large number of distinct
 * `name` aliases because many different humans send through that one mailbox
 * (e.g. a shared ticket-queue mailbox that rewrites the From address to one
 * shared inbox while keeping each sender's name in the display field, which
 * the static `isNonIdentifyingEmail` heuristic can't recognise from the
 * local part alone).
 *
 * For each detected bucket: record any email the heuristic does NOT already
 * catch in `non_identifying_emails` so the resolution path drops it forever
 * after, then delete the person — `person_aliases` and `document_people` go
 * with it via FK ON DELETE CASCADE. Documents that linked only to the bucket
 * lose that (spurious) sender attribution; their other, real person links
 * are untouched. The end state matches what we'd have had if the email had
 * been recognised as non-identifying from the first message.
 *
 * Runs as a boot data migration (before `pruneNoreplyAliases`, so the
 * statically-nameable monsters are removed whole rather than left as husks
 * once prune strips their email alias). Idempotent: a demoted email is
 * either statically non-identifying or blocklisted, so no bucket re-forms
 * and subsequent runs find nothing.
 *
 * Guards (never demoted): address-book people (`source='contacts'`), the
 * self person, and any person entangled in a merge — a merged-away loser
 * (`merged_into` set) or a canonical that other people merged into. The
 * latter structural guard keeps us from orphaning a real identity that an
 * (auto- or user-) merge folded into the bucket.
 */
export function demoteSharedAddresses(
  db: Db,
  nameThreshold: number = DEFAULT_SHARED_ADDRESS_NAME_THRESHOLD,
  maxEmails: number = DEFAULT_SHARED_ADDRESS_MAX_EMAILS,
): DemoteSharedAddressesResult {
  const candidates = db
    .prepare<[number, number], { personId: string; nameCount: number }>(
      `SELECT p.id AS personId,
              COUNT(DISTINCT CASE WHEN a.alias_type = 'name' THEN a.alias END) AS nameCount
       FROM people p
       JOIN person_aliases a ON a.person_id = p.id
       WHERE p.source = 'extracted'
         AND p.is_self = 0
         AND p.merged_into IS NULL
         AND NOT EXISTS (SELECT 1 FROM people l WHERE l.merged_into = p.id)
       GROUP BY p.id
       HAVING nameCount >= ?
          AND COUNT(DISTINCT CASE WHEN a.alias_type = 'email' THEN a.alias END) BETWEEN 1 AND ?`,
    )
    .all(nameThreshold, maxEmails);

  if (candidates.length === 0) return { demoted: 0, emailsBlocked: 0 };

  const emailsOf = db.prepare<[string], { alias: string }>(
    "SELECT DISTINCT alias FROM person_aliases WHERE person_id = ? AND alias_type = 'email'",
  );
  const blocklist = db.prepare(
    `INSERT INTO non_identifying_emails (email, reason, name_count, detected_at)
     VALUES (?, 'shared_address_cardinality', ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name_count = MAX(non_identifying_emails.name_count, excluded.name_count),
       detected_at = excluded.detected_at`,
  );
  const deletePerson = db.prepare("DELETE FROM people WHERE id = ?");

  const now = new Date().toISOString();
  let demoted = 0;
  let emailsBlocked = 0;

  const txn = db.transaction(() => {
    for (const c of candidates) {
      const emails = emailsOf.all(c.personId).map((r) => r.alias);
      for (const email of emails) {
        // Statically-caught addresses (`noreply@`, `invitations@`, …) are
        // already dropped at resolution; only persist the ones the
        // heuristic can't name from the local part.
        if (isNonIdentifyingEmail(email)) continue;
        blocklist.run(normalizeEmail(email), c.nameCount, now);
        emailsBlocked += 1;
      }
      // Cascade removes this person's aliases and document_people links.
      deletePerson.run(c.personId);
      demoted += 1;
      // Routine boot housekeeping — the caller logs a single INFO summary;
      // this per-bucket detail stays at debug for diagnosis.
      log.debug(
        `Demoted shared-address person ${c.personId}: ${c.nameCount} distinct names over [${emails.join(", ")}]`,
      );
    }
    if (demoted > 0) {
      markPeopleGraphDirty(db);
      markMergeRulesDirty(db);
    }
  });
  txn();

  return { demoted, emailsBlocked };
}
