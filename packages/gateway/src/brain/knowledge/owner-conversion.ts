// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  convertKnowledgeOwner,
  LegacyOwnerConversionError,
  readKnowledgeOwner,
  type KnowledgeOwnerKind,
  type LegacyOwnerUnconvertibleReason,
} from "./owner-adapters.js";
import { knowledgeEvidenceAvailability } from "./storage-source-fence.js";
import { knowledgeHash } from "./storage-validation.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

/** Legacy owner tables in the order the conversion sweep visits them. */
export const LEGACY_OWNER_TABLES: ReadonlyArray<readonly [KnowledgeOwnerKind, string]> = [
  ["loop", "open_loops"],
  ["observation", "observations"],
  ["doc_annotation", "doc_annotations"],
  ["person_annotation", "person_annotations"],
];

/**
 * Why the sweep set an owner aside. The first three come from the owner's own
 * inputs; `reference_invalid` and `claim_invalid` are any other refusal of the
 * converted node; `revision_conflict` is a race with a concurrent write.
 */
export type LegacyConversionDeferralReason =
  LegacyOwnerUnconvertibleReason | "reference_invalid" | "claim_invalid" | "revision_conflict";

export type LegacyConversionAttempt =
  | { outcome: "converted" }
  | { outcome: "deferred"; reason: LegacyConversionDeferralReason; retryAt: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A race clears on its own, so it is retried soon. */
const TRANSIENT_BACKOFF = { baseMs: 5 * MINUTE, capMs: 6 * HOUR };
/**
 * An input refusal repeats until the owner or its evidence changes, which the
 * sweep detects through the input fingerprint. The slow timed retry covers
 * changes the fingerprint cannot see, such as a privacy fence lifting.
 */
const INPUT_BACKOFF = { baseMs: 6 * HOUR, capMs: 7 * DAY };

/**
 * Everything that decides whether an owner converts: its canonical record,
 * the sources it cites, and whether each source is still readable evidence.
 * Read-only, so the sweep can tell on a reader whether a set-aside owner changed.
 */
export function legacyOwnerConversionFingerprint(
  db: Database.Database,
  kind: KnowledgeOwnerKind,
  ownerId: string,
): string {
  let owner: ReturnType<typeof readKnowledgeOwner>;
  try {
    owner = readKnowledgeOwner(db, kind, ownerId);
  } catch (error) {
    if (error instanceof LegacyOwnerConversionError && error.reason === "owner_unavailable")
      return knowledgeHash(["owner_unavailable", kind, ownerId]);
    throw error;
  }
  return knowledgeHash([
    owner.versionFingerprint,
    owner.evidenceDocumentIds.map((id) => knowledgeEvidenceAvailability(db, id)),
  ]);
}

function deferralReason(error: KnowledgeStorageError): LegacyConversionDeferralReason | null {
  if (error instanceof LegacyOwnerConversionError) return error.reason;
  return error.code === "reference_invalid" ||
    error.code === "claim_invalid" ||
    error.code === "revision_conflict"
    ? error.code
    : null;
}

export function legacyConversionRetryDelay(
  reason: LegacyConversionDeferralReason,
  attempts: number,
): number {
  const backoff = reason === "revision_conflict" ? TRANSIENT_BACKOFF : INPUT_BACKOFF;
  return Math.min(backoff.capMs, backoff.baseMs * 2 ** Math.min(Math.max(attempts - 1, 0), 30));
}

/**
 * One sweep attempt, run on the writer. A refusal is recorded with its reason
 * and input fingerprint so the sweep leaves the owner alone until its inputs
 * change or its retry comes due, instead of refusing it again every pass.
 */
export function attemptLegacyOwnerConversion(
  db: Database.Database,
  kind: KnowledgeOwnerKind,
  ownerId: string,
  now: number,
): LegacyConversionAttempt {
  try {
    convertKnowledgeOwner(db, kind, ownerId, now);
    db.prepare("DELETE FROM knowledge_conversion_deferrals WHERE kind=? AND owner_id=?").run(
      kind,
      ownerId,
    );
    return { outcome: "converted" };
  } catch (error) {
    if (!(error instanceof KnowledgeStorageError)) throw error;
    const reason = deferralReason(error);
    if (!reason) throw error;
    const previous = db
      .prepare<[string, string], { attempts: number }>(
        "SELECT attempts FROM knowledge_conversion_deferrals WHERE kind=? AND owner_id=?",
      )
      .get(kind, ownerId);
    const attempts = (previous?.attempts ?? 0) + 1;
    const retryAt = now + legacyConversionRetryDelay(reason, attempts);
    db.prepare(
      `INSERT INTO knowledge_conversion_deferrals(kind,owner_id,reason,input_fingerprint,attempts,first_deferred_at,last_attempt_at,retry_at)
       VALUES(@kind,@ownerId,@reason,@fingerprint,@attempts,@now,@now,@retryAt)
       ON CONFLICT(kind,owner_id) DO UPDATE SET reason=excluded.reason,input_fingerprint=excluded.input_fingerprint,
         attempts=excluded.attempts,last_attempt_at=excluded.last_attempt_at,retry_at=excluded.retry_at`,
    ).run({
      kind,
      ownerId,
      reason,
      fingerprint: legacyOwnerConversionFingerprint(db, kind, ownerId),
      attempts,
      now,
      retryAt,
    });
    return { outcome: "deferred", reason, retryAt };
  }
}

/** Conversion progress per owner kind: converted nodes and set-aside owners by reason. */
export function readLegacyConversionStatus(db: Database.Database): Array<{
  kind: KnowledgeOwnerKind;
  converted: number;
  deferred: Partial<Record<LegacyConversionDeferralReason, number>>;
}> {
  return LEGACY_OWNER_TABLES.filter(
    ([, table]) =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
  ).map(([kind, table]) => {
    const converted = db
      .prepare<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM knowledge_nodes WHERE kind=? AND owner_id=id",
      )
      .get(kind)!.count;
    // Only owners the sweep would still visit: present, unconverted and not
    // deleted. A record left behind by another conversion path is ignored.
    const deferred = db
      .prepare<[string], { reason: LegacyConversionDeferralReason; count: number }>(
        `SELECT d.reason,COUNT(*) AS count FROM knowledge_conversion_deferrals d
         JOIN ${table} o ON o.id=d.owner_id
         WHERE d.kind=? AND NOT EXISTS(SELECT 1 FROM knowledge_nodes n WHERE n.id=d.owner_id)
           AND NOT EXISTS(SELECT 1 FROM knowledge_node_tombstones t WHERE t.id=d.owner_id)
         GROUP BY d.reason ORDER BY d.reason`,
      )
      .all(kind);
    return {
      kind,
      converted,
      deferred: Object.fromEntries(deferred.map((row) => [row.reason, row.count])),
    };
  });
}
