// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
import { aliasWriter } from "../data/repositories/PersonAliasRepository.js";
type Db = Database.Database;
import { createLogger } from "@omnesis/core";
import {
  sourceAccountOf,
  sourceTypeOf,
  personIdentifierIsReadable,
  personIdentifiers,
} from "@omnesis/types";
import {
  indexSelfIdentitySources,
  resolveSelfIdentityAlias,
  type SelfIdentitySource,
} from "../self-identity-sources.js";
import { documentsMetadataCodec } from "../data/json-columns.js";
import { markPeopleGraphDirty, markMergeRulesDirty } from "../data/DirtyMarks.js";
import {
  tokenizeName,
  scoreTokenBags,
  type IdfContext,
  type TokenIdf,
} from "./MergeCandidateDetector.js";
import { findOrCreatePerson } from "./PeopleResolutionService.js";
import type { PersonMention } from "@omnesis/types";

const log = createLogger("gateway:people");

/**
 * Score threshold above which a same-name contact card is auto-merged into
 * self. Higher than the global `DEFAULT_SCORE_THRESHOLD` (0.7) used by the
 * merge-candidate detector — consolidation runs unattended at boot, so we
 * lean conservative: only fire on near-identical name bags, leave borderline
 * pairs to the operator-driven merge-candidate flow.
 *
 * Calibrated against the synthetic IDF context below (totalPeople=10,
 * df=1 per self-name token):
 *   "James Bond" ↔ "James Bond" (full match) → ~0.99 ✓
 *   "James" ↔ "James Bond"        (1-token containment) → ~0.91 ✗
 *   "James Smith" ↔ "James Bond"  (partial overlap) → ~0.73 ✗
 * The 0.95 floor keeps the partial / single-token cases safely out.
 */
const SELF_CONSOLIDATION_SCORE_THRESHOLD = 0.95;

/**
 * Logical-merge primitive used by the seed pass. Deliberately local: it
 * does the bare two-statement update (`merged_into` + dirty mark) and skips
 * the `first_seen` / `last_seen` reconciliation that `MergeService.mergePeople`
 * does, because the canonical self is always the alias-richest candidate
 * (which we already preserved) and we don't want to introduce a circular
 * domain dependency from `ContactCardBootstrap` → `MergeService`.
 *
 * Idempotent: skips rows that are already merged or self-pointing.
 */
function consolidateIntoSelf(db: Db, droppedId: string, keepId: string): boolean {
  if (droppedId === keepId) return false;
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE people SET merged_into = ?, is_self = FALSE, updated_at = ? WHERE id = ? AND merged_into IS NULL",
    )
    .run(keepId, now, droppedId);
  return result.changes > 0;
}

/**
 * Snapshot of one contact document the writer needs to seed. Pre-parsed
 * on the read handle so the writer only deals with a typed shape — no
 * JSON.parse on the writer thread.
 */
export interface SeedContactDoc {
  docId: string;
  sourceId: string;
  docDate: string;
  mention: PersonMention;
  isMe: boolean;
}

/**
 * Pure-read plan emitted by `computeSeedFromContacts`. Carries the
 * subset of contact documents the writer should process (those with a
 * mention plus at least one strong identifier) and a snapshot of the
 * existing self-candidate set so the writer doesn't have to re-run the
 * correlated-subquery COUNT for the dedupe pass.
 *
 * The candidate snapshot reflects state BEFORE the seed runs. The
 * writer's `is_self` flips during seeding will produce additional
 * candidates, so the writer recomputes the candidate set itself
 * post-seed and uses this snapshot only as the read-handle precomputed
 * fallback when no isMe doc was processed (i.e. the legacy correlated-
 * COUNT path doesn't need to run on the writer).
 */
export interface SeedFromContactsPlan {
  contactDocs: SeedContactDoc[];
}

/**
 * Pure-read companion to `upsertSeedFromContacts`. Scans
 * `documentType='contact'` documents, parses metadata, filters out
 * contacts without a strong identifier, and returns a structured plan.
 *
 * Designed to run on a read-only handle (IO worker) so the
 * full-table scan + per-row JSON.parse don't park the writer.
 */
export function computeSeedFromContacts(db: Db): SeedFromContactsPlan {
  const rows = db
    .prepare<[], { id: string; metadata: string; source_id: string; source_created_at: string }>(
      `SELECT id, metadata, source_id, source_created_at FROM documents
       WHERE json_extract(metadata, '$.documentType') = 'contact'`,
    )
    .all();

  const contactDocs: SeedContactDoc[] = [];

  for (const row of rows) {
    const meta = documentsMetadataCodec.parseWithFallback(row.metadata, { rowId: row.id }) as {
      people?: PersonMention[];
      extra?: Record<string, unknown>;
    };

    const mention = meta.people?.[0];
    if (!mention) continue;

    // A card is worth bootstrapping when it names a person by something a
    // person recognises; a card carrying only an opaque platform id is not a
    // contact card in the sense this pass means.
    const readable = personIdentifiers(mention).some(({ kind }) =>
      personIdentifierIsReadable(kind),
    );
    if (!readable) continue;

    contactDocs.push({
      docId: row.id,
      sourceId: row.source_id,
      docDate: row.source_created_at,
      mention,
      isMe: meta.extra?.isMe === true,
    });
  }

  return { contactDocs };
}

/**
 * Pure-write companion to `computeSeedFromContacts`. Iterates the plan,
 * runs `findOrCreatePerson` per contact (each is a small bounded write),
 * links the doc, marks it resolved, and flips `is_self` for isMe contacts.
 *
 * The post-seed self-winner dedupe still runs here. It scans the
 * `is_self = TRUE` set (small — at most one row per Apple container);
 * the alias COUNT is materialized via `alias_count` on `people` (kept
 * fresh by `upsertPeopleCounts`), so the legacy correlated subquery is
 * gone. When `alias_count` is unseeded (fresh DB / tests), it falls
 * back to a per-candidate COUNT — bounded by candidate count which
 * stays in single digits in practice.
 */
export function upsertSeedFromContacts(
  db: Db,
  plan: SeedFromContactsPlan,
): { seeded: number; selfDetected: boolean } {
  let seeded = 0;
  let selfDetected = false;

  for (const doc of plan.contactDocs) {
    const personId = findOrCreatePerson(db, doc.mention, doc.sourceId, doc.docDate);
    if (!personId) continue;

    db.prepare(
      "UPDATE people SET source = 'contacts', updated_at = ? WHERE id = ? AND source = 'extracted'",
    ).run(new Date().toISOString(), personId);

    db.prepare(
      `INSERT OR IGNORE INTO document_people (document_id, person_id, role, source_id)
       VALUES (?, ?, 'contact', ?)`,
    ).run(doc.docId, personId, doc.sourceId);

    db.prepare("UPDATE documents SET people_resolved_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      doc.docId,
    );

    if (doc.isMe) {
      db.prepare("UPDATE people SET is_self = TRUE, updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        personId,
      );
      selfDetected = true;
    }

    seeded++;
  }

  // Apple's `isMe` flag is set per *container* (iCloud, Google, Exchange,
  // etc.), so a user who has synced a secondary Google account will have
  // multiple "me" cards — one per container — and each is a different
  // identity (e.g. their assistant or alias account). We want exactly one
  // is_self person. Pick the best candidate (most aliases, tie-break on
  // earliest first_seen) and clear the flag on the rest.
  //
  // Reads `alias_count` materialized on `people`. Falls back to a live
  // COUNT for any candidate whose materialized count is 0 (fresh DB /
  // tests that haven't yet run `upsertPeopleCounts`).
  const selfCandidates = db
    .prepare<[], { id: string; alias_count: number; first_seen: string }>(
      `SELECT p.id, p.first_seen, p.alias_count
       FROM people p
       WHERE p.is_self = TRUE AND p.merged_into IS NULL`,
    )
    .all();

  const needsLiveCount = selfCandidates.some((c) => c.alias_count === 0);
  const candidates = needsLiveCount
    ? selfCandidates.map((c) => {
        const live = db
          .prepare<
            [string],
            { c: number }
          >("SELECT COUNT(*) AS c FROM person_aliases WHERE person_id = ?")
          .get(c.id);
        return { ...c, alias_count: live?.c ?? c.alias_count };
      })
    : selfCandidates;

  let keepSelfId: string | null = null;
  if (candidates.length >= 1) {
    candidates.sort((a, b) => {
      if (b.alias_count !== a.alias_count) return b.alias_count - a.alias_count;
      return a.first_seen.localeCompare(b.first_seen);
    });
    keepSelfId = candidates[0].id;

    // Consolidate every losing isMe candidate into the canonical self via
    // logical merge — they're all "me" cards (per Apple container) and any
    // emails / phones / names they carry legitimately belong to the user.
    // Just clearing `is_self` (the previous behavior) silently dropped those
    // identifiers from self's effective alias set; merging keeps them
    // available via `mergedFrom` dereferencing on read.
    if (candidates.length > 1) {
      const droppedIds = candidates.slice(1).map((c) => c.id);
      let consolidated = 0;
      for (const id of droppedIds) {
        if (consolidateIntoSelf(db, id, keepSelfId)) consolidated++;
      }
      log.warn(
        `Multiple self candidates from isMe contacts [${candidates.map((c) => `${c.id}(${c.alias_count})`).join(", ")}]; kept ${keepSelfId}, consolidated ${consolidated} into self`,
      );
    }
  }

  // Same-name consolidation pass.
  //
  // Apple's `isMe` flag is per-container — a card the user owns but synced
  // through a non-iCloud account (Google contacts, Exchange) won't carry
  // `isMe=true`, so it resolves to a fresh orphan person carrying the
  // user's email / phone but a different identity. After a contacts resync
  // those orphans steal aliases away from canonical self.
  //
  // After establishing canonical self above, scan contact docs whose first
  // mention's name strongly matches self's name aliases (token-bag jaccard
  // ≥ 0.9 via the existing `scoreTokenBags` scorer). For each match,
  // resolve the contact's person and consolidate into self.
  let sameNameMerged = 0;
  if (keepSelfId !== null) {
    sameNameMerged = consolidateSameNameContactsIntoSelf(db, plan, keepSelfId);
  }

  // Seeding can flip is_self on the central person — every score is
  // computed relative to self, and is_self is the top canonical sort key
  // of the merge-rules eval, so both refresh jobs must re-see it.
  if (seeded > 0 || selfDetected) {
    markPeopleGraphDirty(db);
    markMergeRulesDirty(db);
  }

  log.info(
    `Seeded ${seeded} people from contact documents (self: ${selfDetected}, same-name consolidated: ${sameNameMerged})`,
  );
  return { seeded, selfDetected };
}

/**
 * Second self-consolidation pass. Scans the seeded contact docs
 * for cards whose name strongly matches the canonical self's name aliases
 * and folds the resolved person into self via `merged_into`.
 *
 * Uses `tokenizeName` + `scoreTokenBags` from the merge-candidate detector
 * (same algorithm the user-facing merge-candidates UI uses). Threshold is
 * intentionally higher (0.9 vs the detector's 0.7) — this pass runs
 * unattended at boot, so we'd rather miss a borderline match (operator can
 * still merge it manually from the merge-candidates UI) than auto-merge a
 * stranger who happens to share part of the user's name.
 *
 * IDF context is built from self's name token bag alone, treated as the
 * single document. That gives uniform weight across self's name tokens —
 * we don't need cross-corpus IDF here because we're only scoring against
 * one bag.
 */
function consolidateSameNameContactsIntoSelf(
  db: Db,
  plan: SeedFromContactsPlan,
  selfId: string,
): number {
  // Self's name aliases: own + inherited from any merged losers, since the
  // first consolidation pass above may have just folded extra is_self
  // candidates into self.
  const selfNames = db
    .prepare<[string, string], { alias: string }>(
      `SELECT a.alias FROM person_aliases a
       JOIN people p ON p.id = a.person_id
       WHERE a.alias_type = 'name'
         AND (p.id = ? OR p.merged_into = ?)`,
    )
    .all(selfId, selfId)
    .map((r) => r.alias);

  if (selfNames.length === 0) return 0;

  // Combine all of self's name aliases into one token bag — we want to
  // match contacts that share any part of the user's name, not require
  // matching one specific alias.
  const selfTokenBag = new Set<string>();
  for (const name of selfNames) {
    for (const t of tokenizeName(name)) selfTokenBag.add(t);
  }
  if (selfTokenBag.size === 0) return 0;

  // Synthetic IDF: every self-name token gets df=1 against a small
  // synthetic corpus of `totalPeople` people. The exact corpus size
  // doesn't matter for the relative score — what matters is that
  // `log((N+1)/(df+1)) > 0`, so weights are non-zero and the scorer's
  // containment branch can hit ≥ 0.9 on a clean two-token "James
  // Bond" ↔ "James Bond" match. Using N=10 leaves enough head-
  // room for the attenuator to settle near 1.0 without making the
  // weights so heavy that a single-token match accidentally passes.
  const df: TokenIdf = new Map();
  for (const t of selfTokenBag) df.set(t, 1);
  const ctx: IdfContext = { df, totalPeople: 10 };

  let merged = 0;
  for (const doc of plan.contactDocs) {
    if (doc.isMe) continue; // already handled above

    const mentionName = doc.mention.name;
    if (!mentionName) continue;
    const mentionTokens = tokenizeName(mentionName);
    if (mentionTokens.length === 0) continue;

    const { score } = scoreTokenBags([...selfTokenBag], mentionTokens, ctx, { crossType: false });
    if (score < SELF_CONSOLIDATION_SCORE_THRESHOLD) continue;

    // Resolve the contact's person via document_people (the seed pass just
    // wrote it). Skip if it's already self or already merged into self.
    const personRow = db
      .prepare<[string], { person_id: string; merged_into: string | null }>(
        `SELECT dp.person_id, p.merged_into
         FROM document_people dp
         JOIN people p ON p.id = dp.person_id
         WHERE dp.document_id = ? AND dp.role = 'contact'
         LIMIT 1`,
      )
      .get(doc.docId);

    if (!personRow) continue;
    if (personRow.person_id === selfId) continue;
    if (personRow.merged_into === selfId) continue;
    if (personRow.merged_into !== null) continue; // already merged elsewhere

    if (consolidateIntoSelf(db, personRow.person_id, selfId)) {
      merged++;
    }
  }

  if (merged > 0) {
    log.info(`consolidated ${merged} same-name contact cards into self`);
    markPeopleGraphDirty(db);
    markMergeRulesDirty(db);
  }

  return merged;
}

/**
 * Seed the people table from contact-type documents. Source-agnostic.
 * Preserved as `compute + upsert` for direct callers that already
 * have a writable handle and don't want to split the work — e.g.
 * tests and the back-compat write op. The Scheduler-driven boot
 * path uses the split form so the document scan + JSON parsing
 * runs on the IO worker.
 */
export function seedFromContacts(db: Db): { seeded: number; selfDetected: boolean } {
  return upsertSeedFromContacts(db, computeSeedFromContacts(db));
}

/**
 * Attach source-derived self LIDs to the self person so PersonMentions emitted
 * by those sources resolve to self. Returns how many aliases were added.
 *
 * Runs at boot and again whenever a collector pushes its hooks — on its own
 * boot and on every mid-session source add. Both triggers matter: the
 * registry is empty until a collector connects, so the boot pass alone pairs
 * nothing on a fresh process, and a source added later needs its alias on
 * self before its first page of documents arrives.
 *
 * The hooks arrive as an argument: this runs on the writer worker while the
 * registry the pushes fill lives on the HTTP thread, so the caller passes
 * `listSelfIdentitySources()` with the call.
 *
 * Which sources have a self LID and what shape it takes is declared by each
 * source package via `defineSource.selfIdentity` — this pass reads the hooks
 * generically rather than branching on a source name. A source with no
 * declared hook (or whose account fails the declared pattern) contributes no
 * alias.
 *
 * Email/phone source-account aliases are NOT attached here: every synced source
 * account does not necessarily represent the same person (users sync assistant
 * accounts, spam aliases, family member inboxes). Self's email/phone identity
 * comes exclusively from the isMe contact record — any source account that is
 * really the user will match an alias already on self and resolve naturally.
 */
export function detectSelfFromSourceIds(db: Db, hooks: readonly SelfIdentitySource[]): number {
  if (hooks.length === 0) return 0;
  const selfRow = db
    .prepare<
      [],
      { id: string }
    >("SELECT id FROM people WHERE is_self = TRUE AND merged_into IS NULL LIMIT 1")
    .get();
  if (!selfRow) return 0;
  const byType = indexSelfIdentitySources(hooks);
  // The registered sources, not the sources documents happen to carry. A
  // source's alias has to be on self BEFORE its first sync — otherwise its
  // self-authored documents accrue under a duplicate person — and enumerating
  // the registry is one row per source rather than a scan of the corpus on
  // the single writer thread.
  const sourceIds = db
    .prepare<[], { source_id: string }>("SELECT id AS source_id FROM sources")
    .all();
  const now = new Date().toISOString();
  // One commit for the whole pass rather than one per alias.
  const pair = db.transaction((): number => {
    let added = 0;
    for (const { source_id } of sourceIds) {
      const account = sourceAccountOf(source_id);
      if (!account) continue;
      const alias = resolveSelfIdentityAlias(byType, sourceTypeOf(source_id), account);
      // A writer per source, because the vouch names the source that asserts
      // the identifier and each row here names a different one.
      if (alias && aliasWriter(db, source_id, now).claim(selfRow.id, "lid", alias)) added += 1;
    }
    return added;
  });
  return pair();
}
