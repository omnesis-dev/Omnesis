// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { aliasWriter } from "../data/repositories/PersonAliasRepository.js";
import { sourceAccountOf } from "@omnesis/types";
import { accountEmail } from "@omnesis/source-sdk";
import type { AccountDescriptor } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  createLogger,
  isPlaceholderPersonName,
  normalizeEmail,
  normalizePhone,
} from "@omnesis/core";
import { markPeopleGraphDirty, markMergeRulesDirty } from "../data/DirtyMarks.js";

const log = createLogger("gateway:people");

/** Operator-supplied identifiers for the canonical self person. */
export interface SelfIdentityInput {
  /** Display name for self (optional). */
  name?: string;
  /** Normalized email addresses. */
  emails: string[];
  /** Normalized E.164 phone numbers. */
  phones: string[];
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A headline that's a raw identifier or empty placeholder rather than a real
 * name. Defers the email/phone/empty detection to the shared
 * `isPlaceholderPersonName` so it can't drift, and adds the two self-specific
 * sentinels this module seeds a headline-less self with.
 */
function looksLikePlaceholderName(name: string | null): boolean {
  if (!name) return true;
  const n = name.trim();
  if (n === "Self" || n === "Me") return true;
  return isPlaceholderPersonName(n);
}

const uniq = (xs: string[]): string[] => Array.from(new Set(xs));

/**
 * Create the canonical self person from operator-supplied identifiers if none
 * exists yet, or ENRICH the existing self by attaching any missing email/phone
 * aliases (and promoting a placeholder headline to the supplied name).
 *
 * "Self" is the single `people` row with `is_self = TRUE AND merged_into IS
 * NULL`. `reconcileSelfFromConfig` (below) funnels operator identity from
 * `config.self` through this primitive, so editing your identity after a self
 * already exists attaches the new aliases / promotes a placeholder headline
 * rather than no-op'ing. (The legacy per-device annotation has its own,
 * separate create-only bootstrap in `DeviceRepository.bootstrapSelfFromDevices`.)
 *
 * Idempotent: re-running with the same identifiers is a no-op (the
 * `UNIQUE(alias_type, alias, person_id)` constraint + `INSERT OR IGNORE`
 * collapse repeats). Returns the self person's id, or null when there is no
 * self and nothing to anchor one from (no email/phone — a name alone can't
 * attribute documents, so it never creates a self by itself).
 */
export function reconcileSelfIdentity(
  db: Db,
  input: SelfIdentityInput,
  sourceTag: string,
): string | null {
  const emails = uniq(input.emails);
  const phones = uniq(input.phones);
  const name = input.name?.trim() || undefined;

  const existing = db
    .prepare<
      [],
      { id: string; canonical_name: string }
    >("SELECT id, canonical_name FROM people WHERE is_self = TRUE AND merged_into IS NULL LIMIT 1")
    .get();

  const nowIso = new Date().toISOString();
  const aliases = aliasWriter(db, sourceTag, nowIso);

  if (!existing) {
    // A self with no email/phone can't attribute any document, so a name on its
    // own never materializes one — wait for a real identifier.
    if (emails.length === 0 && phones.length === 0) return null;

    const personId = randomUUID();
    const canonicalName = name ?? emails[0] ?? phones[0] ?? "Self";
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
         VALUES (?, ?, ?, TRUE, ?, ?, ?, ?)`,
      ).run(personId, canonicalName, sourceTag, nowIso, nowIso, nowIso, nowIso);
      for (const e of emails) aliases.claim(personId, "email", e);
      for (const p of phones) aliases.claim(personId, "phone", p);
      if (name) aliases.claim(personId, "name", name);
      // Self is the centre every interaction score is measured against,
      // and the top canonical sort key of the merge-rules eval — an is_self
      // change is a compute input the eval must re-see, so both marks bump.
      markPeopleGraphDirty(db);
      markMergeRulesDirty(db);
    });
    tx();
    log.info(
      `Created canonical self person ${personId} from ${sourceTag} (${emails.length} emails, ${phones.length} phones)`,
    );
    return personId;
  }

  // Enrich the existing self with any identifiers it doesn't already carry.
  let changed = false;
  const tx = db.transaction(() => {
    for (const e of emails) {
      if (aliases.claim(existing.id, "email", e)) changed = true;
    }
    for (const p of phones) {
      if (aliases.claim(existing.id, "phone", p)) changed = true;
    }
    if (name) {
      if (aliases.claim(existing.id, "name", name)) changed = true;
      // Promote a raw-identifier / placeholder headline to the real name.
      if (looksLikePlaceholderName(existing.canonical_name) && existing.canonical_name !== name) {
        db.prepare("UPDATE people SET canonical_name = ?, updated_at = ? WHERE id = ?").run(
          name,
          nowIso,
          existing.id,
        );
        changed = true;
      }
    }
    if (changed) {
      markPeopleGraphDirty(db);
      // New aliases on self change what the merge-rules eval resolves.
      markMergeRulesDirty(db);
    }
  });
  tx();
  if (changed) {
    log.info(`Enriched canonical self person ${existing.id} from ${sourceTag}`);
  }
  return existing.id;
}

/**
 * Boot-time bootstrap of self from the operator's `config.self` — the canonical,
 * install-level home for "who you are" (name / emails / phones). Lenient config
 * strings are normalized (and invalid entries dropped with a warning) before
 * being reconciled. No-op when `config.self` is absent/empty.
 */
export function reconcileSelfFromConfig(
  db: Db,
  configSelf: { name?: string; emails?: readonly string[]; phones?: readonly string[] } | undefined,
): string | null {
  if (!configSelf) return null;

  const emails: string[] = [];
  for (const raw of configSelf.emails ?? []) {
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    const normalized = normalizeEmail(trimmed);
    if (EMAIL_SHAPE.test(normalized)) emails.push(normalized);
    else log.warn(`Ignoring malformed self email in config: ${trimmed}`);
  }

  const phones: string[] = [];
  for (const raw of configSelf.phones ?? []) {
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    const normalized = normalizePhone(trimmed);
    if (normalized) phones.push(normalized);
    else log.warn(`Ignoring unparseable self phone in config: ${trimmed}`);
  }

  const name = configSelf.name?.trim() || undefined;
  if (emails.length === 0 && phones.length === 0 && !name) return null;

  return reconcileSelfIdentity(db, { name, emails, phones }, "config");
}

/** A proposed self identity inferred from a synced source account. */
export interface SelfCandidate {
  /** The account email we think is the operator. */
  email: string;
  /** The source id it came from (e.g. `gmail:you@example.com`). */
  sourceId: string;
}

/**
 * Propose who the operator is from the accounts they've already authenticated,
 * so a Gmail-only install (no Apple "me" card, no `config.self` yet) isn't left
 * with no canonical self at all. The authenticated account email IS the source
 * id (`gmail:<email>`, `outlook:<email>`), so we already know it.
 *
 * Deliberately conservative — only a *proposal* the operator confirms (via
 * `omnesis self set` or the portal), never an automatic election:
 *   - returns null when a canonical self already exists, or when `config.self`
 *     already carries identity (it's set but the self person only materializes
 *     at the next boot — without this, the portal nudge would re-ask in the
 *     window between "Set as me" and the restart);
 *   - returns a candidate only when exactly ONE distinct email-shaped source
 *     account exists. Zero (no email sources) or more than one (ambiguous —
 *     could be a secondary / assistant / family account) yields null rather
 *     than a guess.
 */
/** The address a source declared for this account, if it declared one. */
function declaredEmail(account: string | null): string | undefined {
  if (!account) return undefined;
  try {
    const parsed: unknown = JSON.parse(account);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return accountEmail(parsed as AccountDescriptor);
  } catch {
    return undefined;
  }
}

/** The account half of a source id, when it looks like an address. */
function emailShapedAccount(sourceId: string): string | undefined {
  const account = sourceAccountOf(sourceId);
  return account.includes("@") ? account : undefined;
}

export function computeSelfCandidate(
  db: Db,
  configSelf?: { emails?: readonly string[]; phones?: readonly string[] },
): SelfCandidate | null {
  // Identity already decided — either materialized as a self person, or set in
  // config.self (pending the next boot). Nothing to propose either way.
  if ((configSelf?.emails?.length ?? 0) > 0 || (configSelf?.phones?.length ?? 0) > 0) return null;
  const existing = db
    .prepare("SELECT 1 FROM people WHERE is_self = TRUE AND merged_into IS NULL LIMIT 1")
    .get();
  if (existing) return null;

  // A source's own account descriptor when it declared one, so the address is
  // read rather than recognised. Joined from `sources` rather than looked up
  // per row: the same account can own thousands of documents.
  const rows = db
    .prepare<[], { source_id: string; account: string | null }>(
      `SELECT DISTINCT d.source_id AS source_id, s.account AS account
         FROM documents d
         LEFT JOIN sources s ON s.id = d.source_id`,
    )
    .all();

  // email -> source id (deduped, so gmail + calendar + drive on the same
  // account count as one operator email, not three).
  const byEmail = new Map<string, string>();
  for (const { source_id, account } of rows) {
    const declared = declaredEmail(account);
    // Only when the source said nothing. The fallback recognises an address by
    // its shape, which is a guess with one near miss already in the tree: a
    // connection named after the organization it is scoped to reads as
    // `login@organization`, contains an `@`, and is not an address. A source
    // that declares its subject removes the question for itself; the others
    // keep the behaviour they have until they do.
    const candidate = declared ?? emailShapedAccount(source_id);
    if (!candidate) continue;
    const normalized = normalizeEmail(candidate);
    if (!EMAIL_SHAPE.test(normalized)) continue;
    if (!byEmail.has(normalized)) byEmail.set(normalized, source_id);
  }

  if (byEmail.size !== 1) return null;
  const [email, sourceId] = [...byEmail][0];
  return { email, sourceId };
}
