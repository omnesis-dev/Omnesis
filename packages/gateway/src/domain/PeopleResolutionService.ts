// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
import { aliasWriter } from "../data/repositories/PersonAliasRepository.js";
type Db = Database.Database;
import { randomUUID } from "node:crypto";
import {
  isUnstableLid,
  createLogger,
  normalizeEmail,
  normalizeLid,
  isNonIdentifyingEmail,
  hasValidEmailTld,
  cleanPersonName,
  isPlaceholderPersonName,
} from "@omnesis/core";
import { personIdentifierIsReadable, personIdentifiers } from "@omnesis/types";
import { documentsMetadataCodec } from "../data/json-columns.js";
import {
  AliasLookupCache,
  findAliasOwnerCached,
  loadNonIdentifyingEmails,
} from "../data/repositories/PersonRepository.js";
import { markPeopleGraphDirty, markMergeRulesDirty } from "../data/DirtyMarks.js";
import { STRONG_IDENTIFIER_PLACEHOLDERS, STRONG_IDENTIFIER_TYPES } from "./merge/types.js";
import type { PersonIdentifierKind, PersonMention, PersonRole } from "@omnesis/types";

/**
 * The value an identifier is stored and looked up by.
 *
 * The store keeps one form per kind, so a lookup that skips the
 * normalisation the write did matches nothing. Declared per kind rather than
 * inlined at each call, because there are four call sites and the one that
 * forgets is a person who silently splits in two.
 */
function storedIdentifierValue(
  db: Db,
  kind: PersonIdentifierKind,
  value: string,
  cache: AliasLookupCache | null = null,
): string {
  if (kind === "email") return normalizeEmail(value);
  // A collector that has not caught up still sends WhatsApp's ids unprefixed,
  // and the gateway is what upgrades first. See `normalizeLid`.
  if (kind === "lid") {
    const normalized = normalizeLid(value);
    // Ambiguous installed identities keep their exact spelling during the
    // namespace migration. Replaying an older document must keep resolving
    // that identity, not silently choose the owner of its prefixed twin.
    if (normalized !== value && findAliasOwnerCached(db, cache, kind, value)) return value;
    return normalized;
  }
  return value;
}

const log = createLogger("gateway:people");

/**
 * Roles where the display name came from someone *other than* the person
 * being identified. For recipient mentions the name is whatever label the
 * sender put in the To:/Cc: header ("Cloud Team", or even a different
 * person's name). For mentioned mentions the name is extracted heuristically
 * from body text. Neither is reliable as an identity for the resolved person.
 */
const UNTRUSTED_NAME_ROLES: ReadonlySet<PersonRole> = new Set(["recipient", "mentioned"]);

function trustNameForRole(role: PersonRole): boolean {
  return !UNTRUSTED_NAME_ROLES.has(role);
}

/**
 * Occurrence-count floor applied to a name from a `contact`-card mention. Far
 * above any realistic sender-display-name count, so a deliberately-curated
 * contact name wins the dominant-name pick regardless of how often a stray
 * sender name was seen (the user's intent: a saved name beats what senders typed).
 */
export const CONTACT_NAME_FLOOR = 1_000_000;

/** Shortest a name's leading token must be to be treated as a real given name. */
const GUARD_GIVEN_MIN_LEN = 4;

/** Leading given name of a display name (diacritic-folded, lowercased), or null. */
function leadingGiven(name: string | undefined | null): string | null {
  if (!name) return null;
  const toks = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const lead = toks[0];
  return lead && lead.length >= GUARD_GIVEN_MIN_LEN ? lead : null;
}

function givenNamesAgree(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * True when a mention's name carries a given that conflicts with the person's
 * established (canonical) given — used to distrust a weak LID match. A name
 * change (same given, new surname) or a missing/short given is NOT a conflict.
 */
function nameConflictsWithCanonical(db: Db, personId: string, mention: PersonMention): boolean {
  const mentionGiven = leadingGiven(mention.name);
  if (!mentionGiven) return false;
  const row = db
    .prepare<[string], { canonical_name: string }>("SELECT canonical_name FROM people WHERE id = ?")
    .get(personId);
  const canonicalGiven = leadingGiven(row?.canonical_name);
  if (!canonicalGiven) return false;
  return !givenNamesAgree(mentionGiven, canonicalGiven);
}

function trustedName(mention: PersonMention): string | undefined {
  if (!trustNameForRole(mention.role)) return undefined;
  return cleanPersonName(mention.name);
}

/**
 * The trusted display name a mention contributes *to a specific person*,
 * after both the role guard and the self guard. Returns undefined when the
 * mention carries no name we'd trust for `personId`.
 *
 * The self guard: for the self person, name aliases only come from address
 * book entries (role='contact'). Sender display names on self-sent emails
 * are often mailing-list or relayed headers ("Cloud Team") that pollute the
 * user's own identity, so they're rejected.
 *
 * Shared by `addNewAliases` (deciding the `name` alias to insert) and
 * `maybeUpgradeCanonicalName` (deciding whether to promote a real name onto
 * a placeholder headline) so both apply identical trust rules.
 */
function trustedNameForPerson(
  db: Db,
  personId: string,
  mention: PersonMention,
): string | undefined {
  const name = trustedName(mention);
  if (!name || mention.role === "contact") return name;
  const row = db
    .prepare<[string], { is_self: number }>("SELECT is_self FROM people WHERE id = ?")
    .get(personId);
  return row?.is_self === 1 ? undefined : name;
}

/**
 * Promote a real name onto a placeholder headline. When `personId`'s
 * `canonical_name` is a machine-generated placeholder (phone/email-shaped, or
 * "Unknown") and `mention` carries a trusted name for that person, the
 * placeholder is replaced with the name. This keeps a person's headline
 * consistent with their identity no matter which source surfaced the name
 * first.
 *
 * Guardrails:
 *  - Only a placeholder is ever replaced. A real name stands — one trusted
 *    name superseding another is a merge decision, not an upgrade.
 *  - The incoming name is gated through `trustedNameForPerson`, so untrusted
 *    recipient/mentioned roles (and non-contact names on self) never apply.
 *
 * The cheap placeholder check runs first so the common steady-state case (a
 * real headline) costs a single indexed lookup and returns before computing
 * the trusted name. Idempotent: a real headline fails the placeholder check.
 */
function maybeUpgradeCanonicalName(db: Db, personId: string, mention: PersonMention): void {
  const row = db
    .prepare<[string], { canonical_name: string }>("SELECT canonical_name FROM people WHERE id = ?")
    .get(personId);
  if (!row || !isPlaceholderPersonName(row.canonical_name)) return;
  const name = trustedNameForPerson(db, personId, mention);
  if (!name) return;
  db.prepare("UPDATE people SET canonical_name = ?, updated_at = ? WHERE id = ?").run(
    name,
    new Date().toISOString(),
    personId,
  );
}

/** Follow merged_into chain to the canonical person ID. Max 10 hops. */
export function resolvePersonId(db: Db, personId: string): string {
  let current = personId;
  for (let i = 0; i < 10; i++) {
    const row = db
      .prepare<
        [string],
        { merged_into: string | null }
      >("SELECT merged_into FROM people WHERE id = ?")
      .get(current);
    if (!row?.merged_into) return current;
    current = row.merged_into;
  }
  return current;
}

/**
 * Set of `${aliasType}:${value}` keys that must NOT be inserted by
 * `addNewAliases`. Used by the identifier-conflict branch of
 * `findOrCreatePerson` to attach the safe (non-conflicting) subset of a
 * mention's identifiers to the chosen winner without spreading the
 * conflict-causing ones.
 *
 * Values for `email` keys MUST already be `normalizeEmail`-ed by the caller
 * — the lookup here compares against the normalized form `addNewAliases`
 * actually inserts. Phone / LID values are passed through verbatim (sources
 * normalize them upstream).
 */
type AliasSkipSet = ReadonlySet<string>;

function aliasSkipKey(aliasType: string, value: string): string {
  return `${aliasType}:${value}`;
}

/**
 * Add aliases from a PersonMention to an existing person (skips duplicates).
 *
 * `skipAliases` is an optional allow-list filter: any identifier whose
 * `${aliasType}:${value}` key appears in the set is skipped. Names are
 * never alias-lookup keys (we don't resolve people by name), so they're
 * always added when trusted — the conflict path doesn't use the skip set
 * for names.
 */
function addNewAliases(
  db: Db,
  personId: string,
  mention: PersonMention,
  sourceId: string,
  cache?: AliasLookupCache,
  skipAliases?: AliasSkipSet,
): void {
  const now = new Date().toISOString();
  const aliases = aliasWriter(db, sourceId, now);
  // Name aliases tally an occurrence_count so the dominant name can be picked
  // for display + merge. A name from a contact-card mention is seeded to a large
  // floor so a curated name outranks raw sender display-names regardless of how
  // often those were seen (recomputeNamePrimaries reads the same count).
  const nameStmt = db.prepare(
    // A name is born is_primary=1 (participates immediately); recomputeNamePrimaries
    // later demotes it if another name dominates. ON CONFLICT bumps only the count —
    // a re-synced minority name keeps its demoted is_primary until the selector reruns.
    `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at, occurrence_count, is_primary)
     VALUES (?, ?, ?, 'name', ?, ?, ?, 1)
     ON CONFLICT(alias_type, alias, person_id)
       DO UPDATE SET occurrence_count = MAX(occurrence_count + 1, ?)`,
  );

  for (const { kind, value } of personIdentifiers(mention)) {
    const stored = storedIdentifierValue(db, kind, value);
    if (skipAliases?.has(aliasSkipKey(kind, stored))) continue;
    // Defence in depth for the one kind that has a way of not being an
    // identity at all — `findOrCreatePerson` already drops these, but a
    // caller that builds aliases by another path stays safe. A no-reply
    // address fronts every notification of its kind, and an address ending
    // in a TLD that does not exist is a parser gluing text onto a real one.
    if (kind === "email" && (isNonIdentifyingEmail(stored) || !hasValidEmailTld(stored))) continue;
    aliases.claim(personId, kind, stored);
  }

  const cleanedName = trustedNameForPerson(db, personId, mention);
  if (cleanedName) {
    const isContact = mention.role === "contact";
    const seed = isContact ? CONTACT_NAME_FLOOR : 1;
    const floor = isContact ? CONTACT_NAME_FLOOR : 0;
    // The name path keeps its own INSERT for the occurrence tally, so the
    // vouch is the half it borrows.
    nameStmt.run(randomUUID(), personId, cleanedName, sourceId, now, seed, floor);
    aliases.vouch(personId, "name", cleanedName);
  }
  // New aliases may create visibility for future lookups in the same batch —
  // drop the cache so the next `findPersonByAliasCached` re-reads the table.
  if (cache) cache.invalidate();
}

/**
 * Drop shared no-reply / firehose emails from a mention before identity
 * resolution. Returns the mention as-is when nothing changes (cheap fast
 * path); otherwise returns a shallow clone with the offending emails
 * filtered out. If all emails were non-identifying, `emails` is set to
 * `undefined` so the downstream "name-only" branch fires.
 *
 * Two layers decide non-identifying: the static `isNonIdentifyingEmail`
 * heuristic (nameable patterns like `noreply@` / `invitations@`) and the
 * learned `blocklist` Set (addresses the heuristic can't name from the
 * local part — e.g. a ticket-queue mailbox — discovered after the fact by
 * `demoteSharedAddresses`).
 *
 * Why this matters: addresses like `comments-noreply@docs.google.com`
 * front every Google Docs comment notification regardless of author. If
 * we accept them as identity keys, the first notification creates a
 * person bucket and every subsequent notification from a *different*
 * author gets stapled onto the same bucket, eventually merging into
 * whichever real person matches one of the accreted name aliases.
 */
function dropNonIdentifyingEmails(
  mention: PersonMention,
  blocklist?: ReadonlySet<string>,
): PersonMention {
  const identifying = (address: string): boolean =>
    !isNonIdentifyingEmail(address) &&
    hasValidEmailTld(normalizeEmail(address)) &&
    !blocklist?.has(normalizeEmail(address));
  // Both spellings, because both reach the resolver: filtering only the older
  // one would let a source that moved to `identifiers` write exactly the
  // identity keys this exists to refuse.
  const emails = mention.emails?.filter(identifying);
  const identifiers = mention.identifiers?.filter(
    (id) => id.kind !== "email" || identifying(id.value),
  );
  const emailsChanged = emails !== undefined && emails.length !== mention.emails!.length;
  const identifiersChanged =
    identifiers !== undefined && identifiers.length !== mention.identifiers!.length;
  if (!emailsChanged && !identifiersChanged) return mention;
  return {
    ...mention,
    ...(emails === undefined ? {} : { emails: emails.length > 0 ? emails : undefined }),
    ...(identifiers === undefined
      ? {}
      : { identifiers: identifiers.length > 0 ? identifiers : undefined }),
  };
}

/**
 * Find or create a canonical person for a PersonMention.
 * Returns null for name-only mentions (no email, phone, or LID) and for
 * agent mentions, which name a software principal rather than a person.
 *
 * When `cache` is provided, alias lookups short-circuit through the cache
 * within a batch (usually cuts half the DB round-trips on a hot thread).
 */
export function findOrCreatePerson(
  db: Db,
  mention: PersonMention,
  sourceId: string,
  docDate: string,
  cache?: AliasLookupCache,
  blocklist?: ReadonlySet<string>,
): string | null {
  // An agent is not a person: no lookup, no creation, no alias — whatever
  // identifiers the mention carries and whatever person shares its name.
  if (mention.kind === "agent") return null;

  // Shed shared no-reply / firehose emails before any lookup or insert. The
  // filtered mention is used for every downstream branch (identity lookup,
  // conflict skip-set keying, brand-new person creation) so we never
  // accidentally route a shared address through one path while filtering it
  // from another.
  mention = dropNonIdentifyingEmails(mention, blocklist);

  // isSelf: an architectural primitive for sources that know structurally
  // the document is self-authored but have no accountId-as-email to put
  // in `emails` (Things, Obsidian, …). Resolves at write time to whoever
  // is currently the canonical self person; if no self exists yet (fresh
  // DB, contacts not synced), the mention is silently dropped — we don't
  // create a placeholder, which would pollute the people graph.
  if (mention.isSelf === true) {
    const selfRow = db
      .prepare<
        [],
        { id: string }
      >("SELECT id FROM people WHERE is_self = 1 AND merged_into IS NULL LIMIT 1")
      .get();
    if (!selfRow) return null;
    const now = new Date().toISOString();
    db.prepare("UPDATE people SET last_seen = MAX(last_seen, ?), updated_at = ? WHERE id = ?").run(
      docDate,
      now,
      selfRow.id,
    );
    return selfRow.id;
  }

  const carried = personIdentifiers(mention);
  // Only the platform whose identifiers it can re-point: the guard is written
  // for that platform, and a `lid` from another one carries its own namespace
  // so the two are told apart rather than treated alike.
  const hasUnstableLids = carried.some(({ kind, value }) => kind === "lid" && isUnstableLid(value));

  // Name-only mentions don't create people table entries
  if (carried.length === 0) return null;

  // We track BOTH the unique set of matched canonicals (drives the
  // "no match / single match / conflict" branch) AND the per-identifier
  // resolution (`identifierMatches`). The latter carries `ownerId` (the
  // row that DIRECTLY owns the matching alias, pre-merged_into walk) so
  // we can attach NEW aliases to the same row that already owns this
  // mention's other identifiers — instead of cross-walking onto the
  // canonical and polluting its alias set over time.
  //
  // (The conflict path also uses `matchedPersonId` to identify exactly
  // which identifiers caused the conflict and skip ONLY those.)
  const canonical = new Set<string>();
  const identifierMatches: Array<{
    aliasType: "email" | "phone" | "lid";
    /** The lookup value as stored in person_aliases (already normalized). */
    value: string;
    /** Row that directly owns the alias (pre-walk); null on miss. */
    ownerId: string | null;
    /** Resolved canonical person id, or null if no person owns this alias. */
    matchedPersonId: string | null;
  }> = [];

  for (const { kind, value } of personIdentifiers(mention)) {
    const stored = storedIdentifierValue(db, kind, value, cache ?? null);
    const match = findAliasOwnerCached(db, cache ?? null, kind, stored);
    identifierMatches.push({
      aliasType: kind,
      value: stored,
      ownerId: match?.ownerId ?? null,
      matchedPersonId: match?.canonicalId ?? null,
    });
    if (match) canonical.add(match.canonicalId);
  }

  if (canonical.size === 1) {
    const canonicalPersonId = canonical.values().next().value!;
    // ANCHOR for new alias attachment: prefer the strongest-typed
    // matched identifier's *owner* (pre-walk). For canonical rows this
    // equals canonicalPersonId, so behavior is unchanged. For
    // logical-loser rows, new aliases land on the loser — preserving
    // the loser's pre-merge identity and keeping canonical's
    // `aliasesOwn` clean. Strength order email > phone > lid mirrors
    // STRENGTH_RANK in merge-candidates.ts.
    const STRENGTH = { email: 0, phone: 1, lid: 2 } as const;
    const sortedMatches = identifierMatches
      .filter((m) => m.ownerId !== null)
      .sort((a, b) => STRENGTH[a.aliasType] - STRENGTH[b.aliasType]);
    const anchor = sortedMatches[0]?.ownerId ?? canonicalPersonId;
    // Weak-LID guard: a WhatsApp LID is an unstable identifier that can be
    // mis-mapped to the wrong phone — which is a fact about that platform, not
    // about platform identifiers generally. A GitHub login and a Strava
    // athlete number are stable, and were held back by this guard only because
    // nothing could tell the three apart: a committer whose `git config
    // user.name` disagrees with their canonical name would have their GitHub
    // identity withheld and become a second person, which nothing recovers,
    // because a `lid` contributes no name tokens and so never scores as a
    // merge candidate.
    //
    // If this mention carries a re-pointable identifier and single-matches
    // a person but its name conflicts with that person's established name, the
    // match is untrustworthy — hold back the mention's NEW identifiers so a
    // mis-mapped LID can't permanently fuse a different identity onto this
    // person. (The conflicting name still attaches; the frequency selector
    // demotes it, and the held-back identifiers resolve to their own person and
    // can be merged later if genuinely the same.)
    let skipAliases: Set<string> | undefined;
    if (hasUnstableLids && nameConflictsWithCanonical(db, canonicalPersonId, mention)) {
      skipAliases = new Set();
      for (const m of identifierMatches) {
        if (m.matchedPersonId === null) skipAliases.add(aliasSkipKey(m.aliasType, m.value));
      }
      if (skipAliases.size > 0) {
        log.warn(
          `Weak-LID guard: mention name "${mention.name ?? ""}" conflicts with person ${canonicalPersonId}; holding back ${skipAliases.size} new identifier(s) to avoid fusing a mis-mapped identity`,
        );
      }
    }
    addNewAliases(db, anchor, mention, sourceId, cache, skipAliases);
    // Self-heal the displayed headline (the canonical's `canonical_name`),
    // not the anchor's: if it's still a phone/email placeholder and this
    // mention carries a trusted name, promote the real name.
    maybeUpgradeCanonicalName(db, canonicalPersonId, mention);
    // Update last_seen on both the anchor row and its canonical so
    // either page reflects "we saw this identity recently".
    const now = new Date().toISOString();
    db.prepare("UPDATE people SET last_seen = MAX(last_seen, ?), updated_at = ? WHERE id = ?").run(
      docDate,
      now,
      anchor,
    );
    if (anchor !== canonicalPersonId) {
      db.prepare(
        "UPDATE people SET last_seen = MAX(last_seen, ?), updated_at = ? WHERE id = ?",
      ).run(docDate, now, canonicalPersonId);
    }
    // document_people gets attributed to the canonical (the equivalence
    // class root), keeping search and the canonical's docs list working
    // as before. Read paths union docs across the class anyway, so
    // attributing to anchor would also be correct — but canonical-side
    // attribution matches all existing tests + write-paths.
    return canonicalPersonId;
  }

  const resolved = canonical;

  if (resolved.size > 1) {
    // Conflict: the mention's identifiers match multiple distinct people.
    // We deliberately do NOT auto-merge here — the identifiers may legitimately
    // belong to different people (e.g., an Apple Contacts card that mistakenly
    // contains a family member's phone, or a bulk email addressed "To: Cloud
    // Team <your-alias@live.fr>" where the recipient alias is yours but the
    // display name belongs to no one).
    //
    // Pick the earliest-created candidate to link the document to. For
    // alias attachment we used to skip `addNewAliases` entirely — but that
    // silently dropped EVERY identifier on the mention, including ones that
    // had no conflict at all. The bug surfaced as people rows whose
    // `canonical_name` was email-shaped (seeded from mention.emails[0] when
    // the row was first created via a name-only-trusted role) but with no
    // corresponding `email` alias anywhere in `person_aliases`.
    //
    // Fix: split the mention into "conflicting" and "safe" identifiers. An
    // identifier is *conflicting* iff it currently resolves to a person
    // OTHER than the chosen winner — attaching it to the winner would
    // genuinely pollute another identity. An identifier is *safe* iff it
    // resolves to the winner itself (idempotent insert) OR resolves to no
    // one (it's a brand-new alias the winner can legitimately own; no other
    // person currently claims it). Names are always safe — we don't resolve
    // people by name in the lookup loop, so they aren't part of the conflict
    // set, and the existing `is_self`/role guards inside `addNewAliases`
    // still apply.
    //
    // The conflicting identifiers stay where they are. Manual merges
    // (POST /people/merge-rules) remain available for true duplicates.
    const people = [...resolved].map((id) => {
      const row = db
        .prepare<[string], { first_seen: string }>("SELECT first_seen FROM people WHERE id = ?")
        .get(id);
      return { id, firstSeen: row?.first_seen ?? docDate };
    });
    people.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
    const winner = people[0].id;

    const skipAliases = new Set<string>();
    const conflictingForLog: string[] = [];
    for (const m of identifierMatches) {
      if (m.matchedPersonId !== null && m.matchedPersonId !== winner) {
        skipAliases.add(aliasSkipKey(m.aliasType, m.value));
        conflictingForLog.push(`${m.aliasType}=${m.value}→${m.matchedPersonId}`);
      }
    }

    log.warn(
      `Identifier conflict: mention matches ${resolved.size} people [${[...resolved].join(", ")}]; linking to ${winner}, attaching ${identifierMatches.length - skipAliases.size}/${identifierMatches.length} non-conflicting identifiers, skipping [${conflictingForLog.join(", ")}]`,
    );

    addNewAliases(db, winner, mention, sourceId, cache, skipAliases);
    // The winner is the row this document links to; if its headline is
    // still a placeholder and the mention carries a trusted name, heal it.
    maybeUpgradeCanonicalName(db, winner, mention);
    db.prepare("UPDATE people SET last_seen = MAX(last_seen, ?), updated_at = ? WHERE id = ?").run(
      docDate,
      new Date().toISOString(),
      winner,
    );
    return winner;
  }

  // Free-text references may attach a document to an existing identity, but
  // must not manufacture a new person from an otherwise unanchored phone.
  if (mention.allowPersonCreation === false) return null;

  // No match → create new person
  const personId = randomUUID();
  // The first identifier a person would recognise, in the declared kind
  // order — so a mention that moved to the namespaced list is displayed the
  // same way, and a mention carrying only an opaque platform id still reads
  // as unknown rather than as a string of digits.
  const readable = personIdentifiers(mention).find(({ kind }) => personIdentifierIsReadable(kind));
  const name = trustedName(mention) ?? readable?.value ?? "Unknown";
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'extracted', ?, ?, ?, ?)`,
  ).run(personId, name, docDate, docDate, now, now);

  addNewAliases(db, personId, mention, sourceId, cache);
  return personId;
}

/**
 * The strong-identifier alias keys (`type:value`) a contact-roled mention
 * would insert via `addNewAliases`: emails normalized + dropped when
 * non-identifying, phones/lids verbatim. Names are excluded — they are not
 * lookup keys and are never reconciled (a name may legitimately persist from
 * any source). Mirrors `addNewAliases`'s insert rules exactly so the "kept"
 * set matches what's actually written.
 */
function keptStrongAliasKeys(db: Db, mention: PersonMention): Set<string> {
  const keys = new Set<string>();
  for (const { kind, value } of personIdentifiers(mention)) {
    const stored = storedIdentifierValue(db, kind, value);
    if (kind === "email" && isNonIdentifyingEmail(stored)) continue;
    keys.add(aliasSkipKey(kind, stored));
  }
  return keys;
}

/**
 * True iff any OTHER document on `sourceId` (excluding `excludeDocId`) carries
 * a contact-roled mention whose strong identifiers include `(aliasType, value)`.
 * Recomputed from `documents.metadata` so a re-emitted card that dropped an
 * identifier doesn't orphan an alias another card on the same source still
 * vouches for.
 */
function aliasStillVouchedForOnSource(
  db: Db,
  sourceId: string,
  excludeDocId: string,
  aliasType: string,
  value: string,
): boolean {
  const target = aliasSkipKey(aliasType, value);
  const rows = db
    .prepare<
      [string, string],
      { metadata: string }
    >("SELECT metadata FROM documents WHERE source_id = ? AND id != ?")
    .all(sourceId, excludeDocId);
  for (const row of rows) {
    const meta = documentsMetadataCodec.parseWithFallback(row.metadata) as {
      people?: PersonMention[];
    };
    for (const m of meta.people ?? []) {
      if (m.role !== "contact") continue;
      if (keptStrongAliasKeys(db, m).has(target)) return true;
    }
  }
  return false;
}

/**
 * Reconcile a contact card's strong-identifier aliases after re-resolution.
 * The people pipeline is otherwise insert-only for `person_aliases`: when a
 * contact card is re-emitted with an identifier removed (e.g. a phone deleted
 * from an address-book entry), the stale alias would linger forever. This
 * deletes the orphaned strong-identifier rows (email/phone/lid — never names)
 * that this source no longer vouches for.
 *
 * `keptByPerson` maps each contact-resolved person to the union of strong
 * alias keys its contact mentions on this document would insert. A row is a
 * deletion candidate iff it's a strong identifier on `sourceId` not in that
 * kept set; it's deleted only when no OTHER document on the same source still
 * vouches for it.
 */
function reconcileContactAliases(
  db: Db,
  docId: string,
  sourceId: string,
  keptByPerson: Map<string, Set<string>>,
): void {
  // Driven from the assertions, not from `person_aliases.source_id`. That
  // column names only the first source to see an identifier, so keying on it
  // reaches an identifier this source asserts only when this source also
  // happened to be first. Otherwise the card can drop a number and this
  // source's claim on it survives forever, unreachable — a voucher for
  // something nothing actually vouches for any more.
  const selectRows = db.prepare<
    [string, string, ...string[]],
    { id: string; alias_type: string; alias: string }
  >(
    `SELECT pa.id, pa.alias_type, pa.alias FROM person_aliases pa
       JOIN person_alias_assertions a ON a.alias_id = pa.id AND a.source_id = ?
      WHERE pa.person_id = ?
        AND pa.alias_type IN (${STRONG_IDENTIFIER_PLACEHOLDERS})`,
  );
  // This source withdraws its claim; the row goes only if it was the last.
  // A contact card that drops a phone number should stop *this* source
  // asserting it, not remove an identifier a message thread still does.
  const retract = db.prepare(
    "DELETE FROM person_alias_assertions WHERE alias_id = ? AND source_id = ?",
  );
  const deleteRow = db.prepare(
    `DELETE FROM person_aliases
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM person_alias_assertions a WHERE a.alias_id = person_aliases.id
        )`,
  );

  for (const [personId, kept] of keptByPerson) {
    for (const row of selectRows.all(sourceId, personId, ...STRONG_IDENTIFIER_TYPES)) {
      const key = aliasSkipKey(row.alias_type, row.alias);
      if (kept.has(key)) continue;
      if (aliasStillVouchedForOnSource(db, sourceId, docId, row.alias_type, row.alias)) continue;
      retract.run(row.id, sourceId);
      deleteRow.run(row.id);
    }
  }
}

/**
 * Resolve all PersonMentions for a document into document_people links.
 * Returns counts of resolved (matched existing), created (new people), and skipped (name-only).
 */
export function resolveDocumentPeople(
  db: Db,
  docId: string,
  people: PersonMention[],
  sourceId: string,
  docDate: string,
  cache?: AliasLookupCache,
  blocklist?: ReadonlySet<string>,
): { resolved: number; created: number; skipped: number } {
  // The learned non-identifying-email blocklist. Batch callers preload it
  // once and thread it in; the direct (single-document) writer-op path
  // reads it here — the table is tiny so a per-document read is cheap.
  const learned = blocklist ?? loadNonIdentifyingEmails(db);

  // Delete existing links for this document (re-resolution).
  const deleted = db
    .prepare("DELETE FROM document_people WHERE document_id = ?")
    .run(docId).changes;

  let resolved = 0;
  const created = 0;
  let skipped = 0;

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, ?)`,
  );

  // Strong-identifier aliases (email/phone/lid) each contact-roled mention
  // would keep on its resolved person — used to reconcile away aliases that
  // disappeared from a re-emitted contact card.
  const keptContactAliases = new Map<string, Set<string>>();

  for (const mention of people) {
    const personId = findOrCreatePerson(db, mention, sourceId, docDate, cache, learned);
    if (personId === null) {
      skipped++;
      continue;
    }

    insertStmt.run(docId, personId, mention.role, sourceId);

    if (mention.role === "contact") {
      const kept = keptContactAliases.get(personId);
      if (kept) for (const k of keptStrongAliasKeys(db, mention)) kept.add(k);
      else keptContactAliases.set(personId, keptStrongAliasKeys(db, mention));
    }

    // Count whether this was an existing person or newly created
    // (simplified: we count all non-null as resolved)
    resolved++;
  }

  // Insert-only alias attach leaves orphans when a contact card drops an
  // identifier on re-emit; prune the strong-identifier rows this source no
  // longer vouches for.
  if (keptContactAliases.size > 0) {
    reconcileContactAliases(db, docId, sourceId, keptContactAliases);
  }

  // The set of (doc, person, role) edges shifted — invalidate the
  // per-person interaction scores. Idempotent and cheap (a single
  // UPDATE on a 1-row meta table). Bumps even if the new mention list
  // happens to deduplicate to the same set as before; the periodic
  // refresh diff catches the no-op case and persists nothing.
  //
  // Also bump merge_rules dirty: new people / aliases created here
  // may make a previously-dormant merge rule active. Without this
  // bump the rule eval task only re-fires on rule changes and
  // cascade-delete paths, so a user rule whose alias disappeared
  // (source delete) and reappeared (source re-add — what happened
  // on the Drive QA resync) stays dormant indefinitely. The eval's
  // diff filter makes the no-op case cheap.
  if (resolved > 0 || deleted > 0) {
    markPeopleGraphDirty(db);
    markMergeRulesDirty(db);
  }

  return { resolved, created, skipped };
}

/** Process one unresolved document. Returns null when no more work. */
export function backfillOnePerson(
  db: Db,
  cache?: AliasLookupCache,
  blocklist?: ReadonlySet<string>,
): { resolved: number; created: number; skipped: number } | null {
  const row = db
    .prepare<
      [],
      {
        id: string;
        metadata: string;
        source_id: string;
        source_created_at: string;
      }
    >(
      // Unordered — see #63 (prioritise recent arrivals over an arbitrary
      // position in the backlog).
      "SELECT id, metadata, source_id, source_created_at FROM documents WHERE people_resolved_at IS NULL LIMIT 1",
    )
    .get();

  if (!row) return null;

  const meta = documentsMetadataCodec.parseWithFallback(row.metadata, { rowId: row.id }) as {
    people?: PersonMention[];
  };
  const people = meta.people ?? [];
  const result = resolveDocumentPeople(
    db,
    row.id,
    people,
    row.source_id,
    row.source_created_at,
    cache,
    blocklist,
  );

  db.prepare("UPDATE documents SET people_resolved_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.id,
  );

  return result;
}

/**
 * Batched backfill: process up to `batchSize` documents, sharing an
 * alias-lookup cache across them. Returns the number of documents
 * actually processed this cycle.
 *
 * Yieldable: when `options.token` is supplied, each doc commits in its
 * own transaction and the loop polls the preempt token between docs.
 * If a higher-priority op enqueues mid-batch, the loop breaks and we
 * return early with whatever's been processed — the next periodic
 * tick picks up the remainder. Without a token, all docs go in one
 * outer transaction (legacy behavior, faster for boot-time bulk runs).
 *
 * Why batching helps: each bare `db.run` / `db.query.get` is its own
 * implicit transaction; the shared AliasLookupCache skips redundant
 * SELECTs on repeated participants (email threads, group chats).
 */
export function backfillManyPeople(
  db: Db,
  batchSize: number = 50,
  options: { token?: { requested(): boolean } } = {},
): { processed: number; resolved: number; skipped: number } {
  let processed = 0;
  let resolved = 0;
  let skipped = 0;
  const cache = new AliasLookupCache();
  // Loaded once per batch — the table is tiny and effectively static across
  // a batch (only the demotion sweep writes it, on its own cadence).
  const blocklist = loadNonIdentifyingEmails(db);
  const token = options.token;

  if (!token) {
    // Legacy fast path: one outer transaction over the whole batch.
    const txn = db.transaction(() => {
      for (let i = 0; i < batchSize; i++) {
        const r = backfillOnePerson(db, cache, blocklist);
        if (r === null) break;
        processed += 1;
        resolved += r.resolved;
        skipped += r.skipped;
      }
    });
    txn();
    return { processed, resolved, skipped };
  }

  // Yieldable path: per-doc transactions so we can break cleanly when
  // the preempt atomic flips. Per-doc commits cost a few ms each
  // versus one big commit — acceptable trade for sub-second
  // preemption latency on user-priority ops.
  for (let i = 0; i < batchSize; i++) {
    const oneDocTxn = db.transaction(() => backfillOnePerson(db, cache, blocklist));
    const r = oneDocTxn();
    if (r === null) break;
    processed += 1;
    resolved += r.resolved;
    skipped += r.skipped;
    if (token.requested() && i + 1 < batchSize) break;
  }
  // Note: per-doc dirty bumps fire inside `resolveDocumentPeople` —
  // no batch-end bump needed.
  return { processed, resolved, skipped };
}
