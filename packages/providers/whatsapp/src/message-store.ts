// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import EncryptedDatabase from "better-sqlite3-multiple-ciphers";
import {
  createLogger,
  toErrorMessage,
  normalizePhone,
  assertNever,
  readStorageKeySync,
  storageEncryptionRequired,
  storageKeyHex,
} from "@omnesis/core";
import type { LocalStoreProbeResult } from "@omnesis/source-sdk";
import type {
  StoredMessage,
  StoredChat,
  StoredContact,
  HistorySyncState,
  ChatKind,
  MediaState,
  MediaOutcome,
} from "./types.js";

type Db = Database.Database;

const log = createLogger("whatsapp:store");
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");

/** Schema version stamped in `meta.user_version`. Bump when the schema changes. */
const SCHEMA_VERSION = 1;

/** Default number of dirty day-chats drained per `sync()` page (bounds memory + HTTP body). */
const DEFAULT_DRAIN_LIMIT = 200;

/**
 * Default backoff (seconds) between media re-download attempts, indexed by
 * attempt number: 20s, 1m, 5m, 30m, 2h, 6h, then 12h for every later attempt.
 * The short first step catches a CDN-propagation blip on fresh media; the long
 * tail trades quick recovery from a brief outage (phone momentarily asleep,
 * transcriber restarting) against not hammering the WhatsApp media-retry path.
 * Overridable per store (see {@link MessageStoreOptions}) so tests don't sleep
 * and operators can retune without a code change.
 */
const DEFAULT_MEDIA_RETRY_BACKOFF_SEC = [20, 60, 300, 1800, 7200, 21_600, 43_200];

/**
 * Default cap on transient media-download attempts before a message is marked
 * terminally `unavailable`. With the default backoff this spans ~3 days, after
 * which further retries are vanishingly likely to succeed (the CDN blob is gone
 * and no device re-uploaded it) and would only churn re-emits.
 */
const DEFAULT_MEDIA_MAX_ATTEMPTS = 12;

/**
 * When pending media is overdue (a retry just fired and the woken sync hasn't
 * updated `media_next_attempt` yet, or more days are due than one sweep drains),
 * re-check on this cadence rather than spinning. Long enough for a woken sync to
 * run, short enough to drain a backlog promptly.
 */
const MEDIA_RETRY_OVERDUE_RECHECK_MS = 60_000;
/** Floor on a future retry-wake delay (avoids sub-second churn). */
const MEDIA_RETRY_MIN_DELAY_MS = 1_000;
/** Ceiling — `setTimeout` clamps past the 32-bit range and would fire immediately. */
const MEDIA_RETRY_MAX_DELAY_MS = 2_147_483_000;

/** Tunables for the media-download retry policy. */
export interface MediaRetryPolicy {
  /** Backoff schedule in seconds, indexed by (attempt − 1); the last entry repeats. */
  backoffSec: number[];
  /** Transient-failure attempts after which a message becomes `unavailable`. */
  maxAttempts: number;
}

export interface MessageStoreOptions {
  retryPolicy?: Partial<MediaRetryPolicy>;
  /**
   * Whether to run the self-scheduling timer that wakes a sync when a media
   * retry comes due (so backoff fires on its own clock instead of waiting for
   * the next sync poll). Defaults to true; tests disable it for determinism.
   */
  mediaRetryWake?: boolean;
}

/**
 * Seconds to wait before the next media-download attempt, given the (post-
 * increment) attempt count, or `null` once `maxAttempts` is reached — the caller
 * then marks the message terminally `unavailable`. Pure so it can be unit-tested
 * directly and reused by the store.
 */
export function computeMediaRetryDelaySec(
  attempts: number,
  policy: MediaRetryPolicy,
): number | null {
  if (attempts >= policy.maxAttempts) return null;
  const idx = Math.min(Math.max(attempts - 1, 0), policy.backoffSec.length - 1);
  return policy.backoffSec[idx];
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Message types whose media the collector downloads + processes (transcribe / extract). */
const PROCESSABLE_MEDIA_TYPES = new Set(["audio", "image", "document"]);

// Shared by the retry sweep and wake timer; filter before either query's LIMIT/MIN.
// Invalid stored JSON has the same empty-media fallback as rowToMessage().
const MEDIA_RETRY_ELIGIBILITY = `
  media_state = 'pending' AND media_next_attempt IS NOT NULL AND deleted = 0
  AND (@minTimestamp IS NULL OR ts >= @minTimestamp)
  AND (
    (@voiceNotes = 1 AND type = 'audio'
      AND json_extract(CASE WHEN json_valid(media_json) THEN media_json ELSE '{}' END, '$.isVoiceNote') = 1)
    OR (@attachments = 1 AND type IN ('image', 'document')
      AND COALESCE(json_extract(CASE WHEN json_valid(media_json) THEN media_json ELSE '{}' END, '$.mimetype'), '') != '')
  )`;

/**
 * Whether a message carries media we can actually fetch: a processable type
 * plus the decryption key and a CDN locator (mirrors `getMediaDownloader`'s own
 * guard). Media with no keys can never be decrypted, so it's not enrolled in
 * the retry lifecycle — it renders as a plain placeholder forever.
 */
export function isDownloadableMedia(m: StoredMessage): boolean {
  return (
    PROCESSABLE_MEDIA_TYPES.has(m.type) &&
    !!m.media?.mediaKey &&
    (!!m.media.url || !!m.media.directPath)
  );
}

/** UTC `YYYY-MM-DD` for a unix-seconds timestamp (matches SQLite `strftime(... 'unixepoch')`). */
function messageDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().split("T")[0];
}

/** Half-open unix-seconds range [start, end) covering a UTC `YYYY-MM-DD`. */
function dayRange(date: string): [number, number] {
  const start = Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 1000);
  return [start, start + 86_400];
}

/**
 * Parse a stored JSON cell, tolerating a torn/corrupt value (possible after a
 * crash under WAL+synchronous=NORMAL) by returning the fallback rather than
 * throwing out of the constructor — a single bad cell must not block startup.
 */
function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    log.warn("Discarding a corrupt JSON cell in store.db");
    return fallback;
  }
}

function openStoreDatabase(path: string, key: Buffer | null): Db {
  if (!key) return new Database(path);
  if (sqliteFileLooksPlaintext(path)) migratePlaintextStore(path, key);
  const db = new EncryptedDatabase(path) as unknown as Db;
  keyStoreDatabase(db, key);
  return db;
}

function keyStoreDatabase(db: Db, key: Buffer): void {
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key='${storageKeyHex(key)}'`);
}

/**
 * Encrypt the archive by rekeying a staging copy and swapping it in, never by
 * rewriting `store.db` where it lies.
 *
 * `PRAGMA rekey` commits the header page last, so for most of an in-place
 * rekey an interrupted file still reads as plaintext and SQLite rolls it back
 * from the hot journal on the next open. The exception is the commit itself:
 * between the header being written encrypted and the journal being unlinked,
 * the file is an encrypted header over a rollback journal that the keyed pager
 * cannot replay, and every subsequent open fails "file is not a database" —
 * which {@link MessageStore.open} answers by quarantining the archive and
 * bootstrapping an empty one. Rekeying a copy and swapping it with `rename`
 * removes that window: the plaintext original is untouched until one atomic
 * syscall replaces it, so an interruption leaves either the whole archive or
 * the whole encrypted archive and never something in between.
 */
function migratePlaintextStore(path: string, key: Buffer): void {
  const plain = new Database(path);
  try {
    plain.pragma("busy_timeout = 30000");
    // Fold the WAL into the main file before it is copied: the copy carries
    // only `path`, so anything still in the sidecar would be left behind.
    plain.pragma("wal_checkpoint(TRUNCATE)");
    plain.pragma("journal_mode = DELETE");
  } finally {
    plain.close();
  }

  // A leftover from an attempt that was interrupted is a partially rekeyed
  // file, not a resumable one — it is discarded rather than reused.
  const staging = `${path}.rekey`;
  try {
    clearStagingRekey(staging);
    copyFileSync(path, staging);
    const db = new EncryptedDatabase(staging);
    try {
      db.pragma("cipher='sqlcipher'");
      db.pragma("legacy=4");
      db.pragma(`rekey='${storageKeyHex(key)}'`);
    } finally {
      db.close();
    }
  } catch (err) {
    try {
      clearStagingRekey(staging);
    } catch {
      // Whatever stopped the migration may well stop the tidy-up too, and the
      // next attempt clears the staging path before it uses it anyway. The
      // failure worth reporting is the one that stopped the migration.
    }
    // Distinguished from a corrupt archive, and the difference decides whether
    // `store.db` is kept. Everything above this point read the plaintext file
    // successfully, so a failure here — a full disk, a permission — says
    // nothing about the archive, and answering it by quarantining would throw
    // away a perfectly good one to make room for an empty one.
    throw new StoreRekeyFailure(toErrorMessage(err));
  }
  renameSync(staging, path);
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

/** A migration that failed after the archive was read intact. */
class StoreRekeyFailure extends Error {
  constructor(detail: string) {
    super(`WhatsApp store encryption failed and the archive was left as it was: ${detail}`);
    this.name = "StoreRekeyFailure";
  }
}

/** Remove a staging rekey file and any journal SQLite left beside it. */
function clearStagingRekey(staging: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${staging}${suffix}`, { force: true });
  }
}

/**
 * Inspect the archive under `dir` for the host's health check without
 * opening it for use: what is on disk, and whether this host's key opens it.
 * The archive itself is never migrated, repaired or written; SQLite may
 * leave its WAL side files beside a WAL-mode archive, as any reader does.
 * A store that does not exist yet is simply absent.
 */
export function inspectMessageStore(dir: string): LocalStoreProbeResult {
  const label = "WhatsApp message archive";
  const keyName = "whatsapp-store";
  const path = join(dir, "store.db");
  if (!existsSync(path) || statSync(path).size === 0) return { keyName, label, state: "absent" };
  if (sqliteFileLooksPlaintext(path)) return { keyName, label, state: "plaintext" };
  const configDir = dirname(dirname(dir));
  let key: Buffer | null;
  try {
    key = readStorageKeySync(keyName, { configDir });
  } catch {
    return { keyName, label, state: "locked", detail: "Its key could not be read." };
  }
  if (!key) return { keyName, label, state: "locked", detail: "No wrapped key exists for it." };
  try {
    const db = new EncryptedDatabase(path, { readonly: true }) as unknown as Db;
    try {
      keyStoreDatabase(db, key);
      db.prepare("SELECT count(*) FROM sqlite_master").get();
    } finally {
      db.close();
    }
    return { keyName, label, state: "encrypted" };
  } catch (err) {
    // SQLite reports a wrong key as "not a database"; anything else is the
    // file being unreadable right now, which is not a verdict on the key.
    return sqliteNotADatabase(err)
      ? { keyName, label, state: "unverifiable", detail: "It did not open with this host's key." }
      : { keyName, label, state: "locked", detail: "It could not be opened for inspection." };
  } finally {
    key.fill(0);
  }
}

function sqliteNotADatabase(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_NOTADB"
  );
}

function sqliteFileLooksPlaintext(path: string): boolean {
  if (!existsSync(path)) return false;
  const st = statSync(path);
  if (!st.isFile() || st.size < SQLITE_HEADER.length) return false;
  return readFileSync(path).subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER);
}

/**
 * Derive (bareLid, normalizedPhone) from a Baileys-style contact record.
 * Returns null when the contact doesn't carry both a lid and a phoneNumber.
 *
 * `Contact.phoneNumber` is in JID form (`447700000000@s.whatsapp.net`);
 * `Contact.lid` is in LID form (`64171878182992@lid`). Either field can
 * also arrive as a bare value, so accept both shapes.
 */
function deriveLidMapping(contact: StoredContact): [string, string] | null {
  if (!contact.lid || !contact.phoneNumber) return null;
  const lidUser = contact.lid.split("@")[0];
  const phoneDigits = contact.phoneNumber.split("@")[0];
  if (!lidUser || !phoneDigits) return null;
  const normalized = normalizePhone(phoneDigits.startsWith("+") ? phoneDigits : `+${phoneDigits}`);
  if (!normalized) return null;
  return [lidUser, normalized];
}

/**
 * Reduce a Baileys LID JID to its bare user part (no `@lid` / `:device`).
 * Accepts both `"229969796026444@lid"` and `"229969796026444:0@lid"`.
 */
function bareLid(lid: string): string {
  return lid.split("@")[0].split(":")[0];
}

/**
 * Normalize a Baileys phone value to E.164. The lid-mapping surfaces return
 * the PN as a device-suffixed JID (`"447700900123:0@s.whatsapp.net"`); the
 * `lidPnMappings`/`lid-mapping.update` events use the same shape. Strip the
 * `:device` and `@server` parts before parsing — otherwise the digits never
 * parse and the mapping is silently dropped (the most common failure mode).
 */
function pnToE164(pn: string): string | null {
  const digits = pn.split("@")[0].split(":")[0];
  if (!digits) return null;
  return normalizePhone(digits.startsWith("+") ? digits : `+${digits}`);
}

/** Legacy JSON-blob shape, read once during migration then deleted. */
interface LegacyPersistedState {
  messages: Record<string, Record<string, StoredMessage>>;
  chats: Record<string, StoredChat>;
  contacts: Record<string, StoredContact>;
  historySyncComplete: boolean;
}

interface MessageRow {
  chat_jid: string;
  id: string;
  sender_jid: string;
  sender_name: string;
  from_me: number;
  ts: number;
  type: string;
  text: string;
  media_json: string | null;
  reaction_emoji: string | null;
  reaction_target_id: string | null;
  quoted_text: string | null;
  quoted_sender: string | null;
  deleted: number;
  transcript: string | null;
  media_state: string | null;
  media_next_attempt: number | null;
}

/**
 * Durable, per-account ground truth for WhatsApp messages, backed by a
 * `better-sqlite3` database at `<account-dir>/store.db` (WAL).
 *
 * Unlike a transient buffer, messages are **never
 * garbage-collected** — the store is the local archive WhatsApp history is
 * rendered from, and the merge target a one-time backup import writes into.
 * Because a day always re-renders from the complete archive,
 * day-document content is monotonic and never shrinks on buffer rollover, which
 * is what closes the link-loss bug. The gateway DB is an indexed *view*;
 * this store is the reproducible source. Recovery from a wiped/corrupt store is
 * "re-pair the device + history sync" (the store is intentionally non-portable /
 * not backed up).
 *
 * Memory model: the message archive lives **only on disk** (queried per day in
 * `drain()`); chat / contact / lid-mapping metadata is mirrored in RAM (bounded
 * — one entry per chat / contact / distinct LID).
 *
 * Re-emission to the gateway is **commit-gated**: `drain()` is non-destructive
 * and stamps each drained day with a monotonic `emit_seq` carried in the sync
 * cursor. The engine persists the cursor atomically with the documents, so the
 * next `sync()` proves which days actually landed and only then clears their
 * dirty rows. A failed/rejected POST leaves the cursor un-advanced and the days
 * re-emit (idempotent via gateway content-hash dedup).
 */
export class MessageStore {
  private db: Db;

  /** Chat metadata mirrored in RAM (durably persisted to the `chats` table). */
  private chats = new Map<string, StoredChat>();
  /** Contact metadata mirrored in RAM (durably persisted to the `contacts` table). */
  private contacts = new Map<string, StoredContact>();
  /** LID → E.164 phone mapping mirrored in RAM (durably persisted to `lid_phone`). */
  private _lidPhoneMap = new Map<string, string>();
  /** LIDs seen mapping to >1 phone — untrusted, never resolved to a phone. */
  private _contestedLids = new Set<string>();

  /** Monotonic counter backing `dirty_days.emit_seq`; persisted in `meta`. */
  private emitSeqCounter = 0;
  /** Durable identity of this archive, independent of its filesystem location. */
  readonly storeId: string;

  /** Optional callback fired when new messages arrive / mutate. */
  private changeHandler: (() => void) | null = null;

  /** Account directory (for migration + corrupt-DB quarantine), or null for in-memory. */
  private readonly dir: string | null;

  /** Effective media-download retry policy (defaults + caller overrides). */
  private readonly retryPolicy: MediaRetryPolicy;

  /** Whether the media-retry wake timer is enabled (off in tests). */
  private readonly mediaRetryWakeEnabled: boolean;
  /** Self-rescheduling timer that wakes a sync when a media retry comes due. */
  private mediaRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private mediaRetryScope = { voiceNotes: 1, attachments: 1, minTimestamp: null as number | null };

  // ── Prepared statements (lazily created in #prepare after schema setup) ──
  private stmts!: {
    insertMessage: Database.Statement;
    insertMessageIfAbsent: Database.Statement;
    markDeleted: Database.Statement;
    updateText: Database.Statement;
    upsertDirty: Database.Statement;
    upsertChat: Database.Statement;
    upsertContact: Database.Statement;
    upsertLid: Database.Statement;
    deleteLid: Database.Statement;
    insertContested: Database.Statement;
    setMeta: Database.Statement;
    getMeta: Database.Statement;
  };

  /**
   * @param dir Account directory (e.g. `<config>/whatsapp/+1555…`). When
   *   omitted the store is in-memory (`:memory:`), used by unit tests.
   * @param options Optional overrides (e.g. a fast media-retry policy for tests).
   */
  constructor(dir?: string, options?: MessageStoreOptions) {
    this.dir = dir ?? null;
    const backoffSec = options?.retryPolicy?.backoffSec;
    this.retryPolicy = {
      // Reject an empty override: an empty schedule would index to `undefined`
      // and persist a NaN `media_next_attempt` that wedges a message in pending.
      backoffSec:
        backoffSec && backoffSec.length > 0 ? backoffSec : DEFAULT_MEDIA_RETRY_BACKOFF_SEC,
      maxAttempts: options?.retryPolicy?.maxAttempts ?? DEFAULT_MEDIA_MAX_ATTEMPTS,
    };
    this.mediaRetryWakeEnabled = options?.mediaRetryWake ?? true;
    this.db = this.open();
    this.runSchema(this.db);
    this.prepare();
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('store_id', ?)")
      .run(randomUUID());
    this.storeId = this.getMeta("store_id")!;
    this.maybeMigrateFromJson();
    this.loadMetadata();
    this.emitSeqCounter = this.computeEmitSeqHighWater();
  }

  /** Open the DB with resilient corrupt-file quarantine. */
  private open(): Db {
    if (!this.dir) return this.configurePragmas(new Database(":memory:"));
    mkdirSync(this.dir, { recursive: true });
    const dbPath = join(this.dir, "store.db");
    const storageKey = this.readStoreEncryptionKey();
    try {
      try {
        return this.configurePragmas(openStoreDatabase(dbPath, storageKey));
      } catch (err) {
        // A migration that failed with the archive intact is not this case:
        // quarantining there would answer a full disk by destroying the very
        // thing that could not be copied. It is raised instead, which is the
        // same posture as a required key being unavailable.
        if (err instanceof StoreRekeyFailure) throw err;
        // Corrupt / locked / stale-WAL file: quarantine and re-bootstrap fresh
        // rather than throwing (which would skip or crash the source). The
        // archive is rebuildable via re-pair, so a clean restart is acceptable.
        log.error(`store.db open failed (${toErrorMessage(err)}); quarantining and starting fresh`);
        try {
          const quarantined = `${dbPath}.corrupt-${Date.now()}`;
          if (existsSync(dbPath)) renameSync(dbPath, quarantined);
          // The sidecars move with the file they belong to. A `-wal` or a
          // `-journal` holds the pages that would roll the quarantined archive
          // back, so deleting them is what turns "set this aside for a human"
          // into "lose it"; leaving them in place is worse still, because they
          // would then be sitting beside the empty database opened next. The
          // `-shm` is a derived index of a WAL that is no longer here, so it
          // goes rather than travelling with it.
          for (const sfx of ["-wal", "-journal"]) {
            if (existsSync(dbPath + sfx)) renameSync(dbPath + sfx, quarantined + sfx);
          }
          rmSync(dbPath + "-shm", { force: true });
        } catch (quarantineErr) {
          log.warn(`Failed to quarantine corrupt store.db: ${toErrorMessage(quarantineErr)}`);
        }
        return this.configurePragmas(openStoreDatabase(dbPath, storageKey));
      }
    } finally {
      storageKey?.fill(0);
    }
  }

  private readStoreEncryptionKey(): Buffer | null {
    if (!this.dir) return null;
    const configDir = dirname(dirname(this.dir));
    const key = readStorageKeySync("whatsapp-store", { configDir });
    if (key) return key;
    if (storageEncryptionRequired(configDir)) {
      throw new Error(
        "WhatsApp store encryption is required, but the whatsapp-store key is unavailable. Unlock the Omnesis keyring or run `omnesis keyring storage-init`.",
      );
    }
    return null;
  }

  private configurePragmas(db: Db): Db {
    db.pragma("journal_mode = WAL");
    // Provider-internal rebuildable cache: NORMAL is durable enough (the phone
    // is the real ground truth), and far cheaper than FULL for history bursts.
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    // Force pread() over mmap — same SIGBUS-avoidance rationale as the gateway.
    db.pragma("mmap_size = 0");
    db.pragma("wal_autocheckpoint = 1000");
    return db;
  }

  private runSchema(db: Db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        chat_jid TEXT NOT NULL,
        id TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        from_me INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        media_json TEXT,
        reaction_emoji TEXT,
        reaction_target_id TEXT,
        quoted_text TEXT,
        quoted_sender TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        transcript TEXT,
        media_state TEXT,
        media_attempts INTEGER NOT NULL DEFAULT 0,
        media_last_attempt INTEGER,
        media_next_attempt INTEGER,
        media_last_error TEXT,
        PRIMARY KEY (chat_jid, id)
      );
      CREATE INDEX IF NOT EXISTS messages_by_chat_ts ON messages(chat_jid, ts);

      CREATE TABLE IF NOT EXISTS dirty_days (
        chat_jid TEXT NOT NULL,
        date TEXT NOT NULL,
        emit_seq INTEGER,
        PRIMARY KEY (chat_jid, date)
      );
      CREATE INDEX IF NOT EXISTS dirty_days_emit_seq ON dirty_days(emit_seq);

      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_group INTEGER NOT NULL,
        kind TEXT,
        parent_community_jid TEXT,
        participants_json TEXT,
        participants_fetched_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        push_name TEXT,
        phone_number TEXT,
        lid TEXT,
        verified_name TEXT,
        username TEXT
      );

      CREATE TABLE IF NOT EXISTS lid_phone (
        lid TEXT PRIMARY KEY,
        phone TEXT NOT NULL
      );

      -- LIDs observed mapping to >1 distinct phone. WhatsApp's LID↔phone
      -- mapping is unstable; a contested LID is untrusted — we never derive a
      -- phone for it (mentions stay LID-only), so a bad pairing can't staple a
      -- stranger's phone onto a person downstream.
      CREATE TABLE IF NOT EXISTS lid_contested (
        lid TEXT PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Additive column migrations for stores created before a column existed.
    // ADD COLUMN is a no-op on a fresh DB (the CREATE above already has them).
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]).map((c) => c.name),
    );
    // Voice-note transcripts (speech-to-text).
    if (!cols.has("transcript")) {
      db.exec(`ALTER TABLE messages ADD COLUMN transcript TEXT`);
    }
    // Media download/processing lifecycle (resilient retry — see MediaState).
    const mediaCols: [string, string][] = [
      ["media_state", "TEXT"],
      ["media_attempts", "INTEGER NOT NULL DEFAULT 0"],
      ["media_last_attempt", "INTEGER"],
      ["media_next_attempt", "INTEGER"],
      ["media_last_error", "TEXT"],
    ];
    const addedMediaCols = mediaCols.filter(([name]) => !cols.has(name));
    for (const [name, decl] of addedMediaCols) {
      db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${decl}`);
    }
    if (addedMediaCols.length > 0) {
      // Backfill on first upgrade only. Already-transcribed voice notes become
      // `done`/`empty` so the retry sweep skips them. Everything else (incl.
      // never-transcribed voice notes and all attachments) is intentionally
      // left NULL: NULL keeps the pre-existing opportunistic behavior (retried
      // only when its day re-dirties), so the upgrade does NOT trigger an
      // archive-wide re-download storm. New media arriving after the upgrade is
      // initialized to `pending` and gets the full backoff retry; a resync opts
      // the whole archive back into reprocessing.
      db.exec(`
        UPDATE messages SET media_state = 'done'
          WHERE type = 'audio' AND transcript IS NOT NULL AND transcript != '';
        UPDATE messages SET media_state = 'empty'
          WHERE type = 'audio' AND transcript = '';
      `);
    }

    // Created here (not in the CREATE block above) because it references the
    // media columns, which on an upgraded DB exist only after the ALTERs run.
    db.exec(
      `CREATE INDEX IF NOT EXISTS messages_media_retry ON messages(media_state, media_next_attempt)`,
    );
  }

  private prepare(): void {
    this.stmts = {
      // `media_state` / `media_next_attempt` are set on INSERT (so new
      // downloadable media starts `pending`, due immediately) but deliberately
      // left OUT of the DO UPDATE SET clause: a re-delivery / edit of an existing
      // message must NOT reset its media lifecycle (that's owned by
      // `recordMediaOutcome` / `resetMediaForResync`).
      insertMessage: this.db.prepare(`
        INSERT INTO messages (chat_jid, id, sender_jid, sender_name, from_me, ts, type, text,
          media_json, reaction_emoji, reaction_target_id, quoted_text, quoted_sender, deleted,
          media_state, media_next_attempt)
        VALUES (@chat_jid, @id, @sender_jid, @sender_name, @from_me, @ts, @type, @text,
          @media_json, @reaction_emoji, @reaction_target_id, @quoted_text, @quoted_sender, @deleted,
          @media_state, @media_next_attempt)
        ON CONFLICT(chat_jid, id) DO UPDATE SET
          sender_jid = excluded.sender_jid, sender_name = excluded.sender_name,
          from_me = excluded.from_me, ts = excluded.ts, type = excluded.type, text = excluded.text,
          media_json = excluded.media_json, reaction_emoji = excluded.reaction_emoji,
          reaction_target_id = excluded.reaction_target_id, quoted_text = excluded.quoted_text,
          quoted_sender = excluded.quoted_sender, deleted = excluded.deleted
      `),
      // Insert-if-absent for the backup import: a colliding id is left
      // untouched so a sparse imported row never clobbers a richer live row.
      insertMessageIfAbsent: this.db.prepare(`
        INSERT INTO messages (chat_jid, id, sender_jid, sender_name, from_me, ts, type, text,
          media_json, reaction_emoji, reaction_target_id, quoted_text, quoted_sender, deleted,
          media_state, media_next_attempt)
        VALUES (@chat_jid, @id, @sender_jid, @sender_name, @from_me, @ts, @type, @text,
          @media_json, @reaction_emoji, @reaction_target_id, @quoted_text, @quoted_sender, @deleted,
          @media_state, @media_next_attempt)
        ON CONFLICT(chat_jid, id) DO NOTHING
      `),
      markDeleted: this.db.prepare(`UPDATE messages SET deleted = 1 WHERE chat_jid = ? AND id = ?`),
      updateText: this.db.prepare(`UPDATE messages SET text = ? WHERE chat_jid = ? AND id = ?`),
      upsertDirty: this.db.prepare(`
        INSERT INTO dirty_days (chat_jid, date, emit_seq) VALUES (?, ?, NULL)
        ON CONFLICT(chat_jid, date) DO UPDATE SET emit_seq = NULL
      `),
      upsertChat: this.db.prepare(`
        INSERT INTO chats (jid, name, is_group, kind, parent_community_jid,
          participants_json, participants_fetched_at)
        VALUES (@jid, @name, @is_group, @kind, @parent_community_jid,
          @participants_json, @participants_fetched_at)
        ON CONFLICT(jid) DO UPDATE SET
          name = excluded.name, is_group = excluded.is_group,
          kind = COALESCE(excluded.kind, chats.kind),
          parent_community_jid = COALESCE(excluded.parent_community_jid, chats.parent_community_jid),
          participants_json = excluded.participants_json,
          participants_fetched_at = excluded.participants_fetched_at
      `),
      upsertContact: this.db.prepare(`
        INSERT INTO contacts (jid, name, push_name, phone_number, lid, verified_name, username)
        VALUES (@jid, @name, @push_name, @phone_number, @lid, @verified_name, @username)
        ON CONFLICT(jid) DO UPDATE SET
          name = excluded.name, push_name = excluded.push_name, phone_number = excluded.phone_number,
          lid = excluded.lid, verified_name = excluded.verified_name, username = excluded.username
      `),
      upsertLid: this.db.prepare(`
        INSERT INTO lid_phone (lid, phone) VALUES (?, ?)
        ON CONFLICT(lid) DO UPDATE SET phone = excluded.phone
      `),
      deleteLid: this.db.prepare(`DELETE FROM lid_phone WHERE lid = ?`),
      insertContested: this.db.prepare(`INSERT OR IGNORE INTO lid_contested (lid) VALUES (?)`),
      setMeta: this.db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
      getMeta: this.db.prepare(`SELECT value FROM meta WHERE key = ?`),
    };
  }

  // ────────────────────────────── metadata RAM ──────────────────────────────

  private loadMetadata(): void {
    for (const row of this.db.prepare(`SELECT * FROM chats`).all() as Record<string, unknown>[]) {
      this.chats.set(row.jid as string, this.rowToChat(row));
    }
    for (const row of this.db.prepare(`SELECT * FROM contacts`).all() as Record<
      string,
      unknown
    >[]) {
      this.contacts.set(row.jid as string, {
        jid: row.jid as string,
        name: row.name as string,
        pushName: (row.push_name as string) ?? undefined,
        phoneNumber: (row.phone_number as string) ?? undefined,
        lid: (row.lid as string) ?? undefined,
        verifiedName: (row.verified_name as string) ?? undefined,
        username: (row.username as string) ?? undefined,
      });
    }
    for (const row of this.db.prepare(`SELECT lid FROM lid_contested`).all() as {
      lid: string;
    }[]) {
      this._contestedLids.add(row.lid);
    }
    for (const row of this.db.prepare(`SELECT lid, phone FROM lid_phone`).all() as {
      lid: string;
      phone: string;
    }[]) {
      if (this._contestedLids.has(row.lid)) continue; // untrusted — no phone
      this._lidPhoneMap.set(row.lid, row.phone);
    }
  }

  private rowToChat(row: Record<string, unknown>): StoredChat {
    const participants = row.participants_json
      ? safeJsonParse<string[] | undefined>(row.participants_json as string, undefined)
      : undefined;
    return {
      jid: row.jid as string,
      name: row.name as string,
      isGroup: !!row.is_group,
      kind: (row.kind as ChatKind) ?? undefined,
      parentCommunityJid: (row.parent_community_jid as string) ?? undefined,
      participants,
      participantsFetchedAt: (row.participants_fetched_at as number) ?? undefined,
    };
  }

  private writeChat(chat: StoredChat): void {
    this.stmts.upsertChat.run({
      jid: chat.jid,
      name: chat.name,
      is_group: chat.isGroup ? 1 : 0,
      kind: chat.kind ?? null,
      parent_community_jid: chat.parentCommunityJid ?? null,
      participants_json: chat.participants ? JSON.stringify(chat.participants) : null,
      participants_fetched_at: chat.participantsFetchedAt ?? null,
    });
  }

  private writeContact(c: StoredContact): void {
    this.stmts.upsertContact.run({
      jid: c.jid,
      name: c.name,
      push_name: c.pushName ?? null,
      phone_number: c.phoneNumber ?? null,
      lid: c.lid ?? null,
      verified_name: c.verifiedName ?? null,
      username: c.username ?? null,
    });
  }

  private getMeta(key: string): string | undefined {
    const row = this.stmts.getMeta.get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.stmts.setMeta.run(key, value);
  }

  private computeEmitSeqHighWater(): number {
    const fromMeta = Number.parseInt(this.getMeta("emit_seq_counter") ?? "0", 10) || 0;
    const row = this.db.prepare(`SELECT COALESCE(MAX(emit_seq), 0) AS m FROM dirty_days`).get() as {
      m: number;
    };
    return Math.max(fromMeta, row.m);
  }

  // ───────────────────────────── change handler ─────────────────────────────

  /**
   * Stop notifying `handler`, if it is the one currently registered.
   *
   * Guarded on identity so a source torn down after another has taken over
   * cannot silence the live listener — the late teardown of a replaced
   * registration is exactly the case where an unguarded clear goes quiet.
   */
  offChange(handler: () => void): void {
    if (this.changeHandler === handler) this.changeHandler = null;
  }

  onChange(handler: () => void): void {
    this.changeHandler = handler;
    // A listener now exists, so retries that came due while the collector was
    // down (or before the source registered) can wake a sync.
    this.scheduleNextMediaRetry();
  }

  /**
   * Wake a sync without an underlying data change. Used to recover the source
   * out of an error state after the connection is restored: a quiet reconnect
   * may deliver no new message to fire the change handler on its own, so the
   * provider pokes it explicitly so the next sync flips the source back healthy.
   */
  wakeSync(): void {
    this.changeHandler?.();
  }

  setMediaRetryScope(scope: {
    voiceNotes: boolean;
    attachments: boolean;
    minTimestamp: number | null;
  }): void {
    // Disabled processing must not requeue old days or wake useless syncs.
    // Scope is runtime-only: pending media survives for a later config change.
    this.mediaRetryScope = {
      voiceNotes: Number(scope.voiceNotes),
      attachments: Number(scope.attachments),
      minTimestamp: scope.minTimestamp,
    };
    this.scheduleNextMediaRetry();
  }

  /**
   * Arm a single, coalesced, `unref()`'d timer to wake a sync (`changeHandler`)
   * when the earliest eligible media's backoff elapses — so retries fire on the
   * backoff clock rather than waiting for the next sync poll. The woken sync's
   * `markDueMediaDirty` re-dirties the due days and the drain retries them.
   * Self-reschedules; no-op without a listener or when disabled (tests).
   */
  private scheduleNextMediaRetry(): void {
    if (this.mediaRetryTimer) {
      clearTimeout(this.mediaRetryTimer);
      this.mediaRetryTimer = undefined;
    }
    if (!this.mediaRetryWakeEnabled || !this.changeHandler) return;
    const row = this.db
      .prepare(`SELECT MIN(media_next_attempt) AS m FROM messages WHERE ${MEDIA_RETRY_ELIGIBILITY}`)
      .get(this.mediaRetryScope) as { m: number | null };
    if (row.m == null) return; // nothing pending → leave the timer disarmed
    const dueMs = row.m * 1000;
    const delay =
      dueMs <= Date.now()
        ? MEDIA_RETRY_OVERDUE_RECHECK_MS
        : Math.min(
            Math.max(dueMs - Date.now(), MEDIA_RETRY_MIN_DELAY_MS),
            MEDIA_RETRY_MAX_DELAY_MS,
          );
    this.mediaRetryTimer = setTimeout(() => {
      this.mediaRetryTimer = undefined;
      this.changeHandler?.();
      // Backstop re-arm: the woken sync is async, so until it attempts and
      // updates `media_next_attempt` the row stays overdue → re-check cadence.
      this.scheduleNextMediaRetry();
    }, delay);
    // Never let the timer keep the process alive on its own.
    this.mediaRetryTimer.unref?.();
  }

  // ─────────────────────────── history sync state ───────────────────────────

  get historySyncState(): HistorySyncState {
    const v = this.getMeta("history_sync_state");
    return v === "complete" || v === "interrupted" ? v : "streaming";
  }

  setHistorySyncState(state: HistorySyncState): void {
    this.setMeta("history_sync_state", state);
  }

  /** Compat read used by the source's phase/hasMore logic. */
  get historySyncComplete(): boolean {
    return this.historySyncState === "complete";
  }

  // ───────────────────────────────── ingest ─────────────────────────────────

  private markDirtyRow(chatJid: string, date: string): void {
    this.stmts.upsertDirty.run(chatJid, date);
  }

  /**
   * Ensure a `chats` row exists for a JID, even when messages arrive before the
   * chat's metadata. A stub carries the JID as the name; a later `addChats`
   * upserts the real name/roster.
   */
  private ensureChat(jid: string): void {
    if (this.chats.has(jid)) return;
    const stub: StoredChat = { jid, name: jid, isGroup: jid.endsWith("@g.us") };
    this.chats.set(jid, stub);
    this.writeChat(stub);
  }

  /** Bind object for the message INSERT statements. */
  private messageParams(m: StoredMessage): Record<string, string | number | null> {
    // Downloadable media (has decryption keys + a CDN locator) starts its
    // lifecycle `pending`, due immediately (next_attempt = 0), so the first
    // sync after it arrives downloads + processes it while the CDN blob is
    // freshest. Non-media — and media that can never be fetched (no keys) —
    // stays NULL: not a candidate for the retry sweep.
    const downloadable = isDownloadableMedia(m);
    return {
      chat_jid: m.chatJid,
      id: m.id,
      sender_jid: m.senderJid,
      sender_name: m.senderName,
      from_me: m.fromMe ? 1 : 0,
      ts: m.timestamp,
      type: m.type,
      text: m.text,
      media_json: m.media ? JSON.stringify(m.media) : null,
      reaction_emoji: m.reactionEmoji ?? null,
      reaction_target_id: m.reactionTargetId ?? null,
      quoted_text: m.quotedText ?? null,
      quoted_sender: m.quotedSender ?? null,
      deleted: m.deleted ? 1 : 0,
      media_state: downloadable ? "pending" : null,
      media_next_attempt: downloadable ? 0 : null,
    };
  }

  /** Upsert one message row and mark its day dirty. Caller owns the transaction. */
  private writeMessage(m: StoredMessage): void {
    this.ensureChat(m.chatJid);
    this.stmts.insertMessage.run(this.messageParams(m));
    this.markDirtyRow(m.chatJid, messageDate(m.timestamp));
  }

  addMessages(msgs: StoredMessage[]): void {
    if (msgs.length === 0) return;
    const tx = this.db.transaction((batch: StoredMessage[]) => {
      for (const m of batch) this.writeMessage(m);
    });
    tx(msgs);
    log.debug(`Stored ${msgs.length} messages`);
    this.changeHandler?.();
    // New downloadable media enters `pending` due now — arm the wake timer as a
    // backstop in case the push-triggered sync is delayed behind a long drain.
    this.scheduleNextMediaRetry();
  }

  /**
   * Bulk-import messages from an external archive (the backup import),
   * reporting how many were new (`imported`) vs already present (`merged`),
   * keyed on the stable `(chat_jid, id)`. Uses insert-if-absent so an imported
   * row **never overwrites** a richer live-synced row (live carries media keys
   * the backup lacks); a colliding id is left untouched and counted as `merged`.
   * Only newly-inserted rows mark their day dirty. Idempotent: re-importing the
   * same archive yields `imported: 0`.
   */
  importMessages(msgs: StoredMessage[]): { imported: number; merged: number } {
    if (msgs.length === 0) return { imported: 0, merged: 0 };
    let imported = 0;
    let merged = 0;
    const tx = this.db.transaction((batch: StoredMessage[]) => {
      for (const m of batch) {
        this.ensureChat(m.chatJid);
        const info = this.stmts.insertMessageIfAbsent.run(this.messageParams(m));
        if (info.changes > 0) {
          imported++;
          this.markDirtyRow(m.chatJid, messageDate(m.timestamp));
        } else {
          merged++;
        }
      }
    });
    tx(msgs);
    log.info(`Imported ${imported} new + ${merged} already-present messages`);
    this.changeHandler?.();
    this.scheduleNextMediaRetry();
    return { imported, merged };
  }

  addChats(chats: StoredChat[]): void {
    if (chats.length === 0) return;
    const tx = this.db.transaction((batch: StoredChat[]) => {
      for (const chat of batch) {
        // Preserve roster fields if already populated and the incoming record
        // omits them (chats.upsert events carry no participant list).
        const existing = this.chats.get(chat.jid);
        const next: StoredChat =
          existing && chat.participants === undefined && existing.participants !== undefined
            ? {
                ...chat,
                participants: existing.participants,
                participantsFetchedAt: existing.participantsFetchedAt,
                kind: chat.kind ?? existing.kind,
                parentCommunityJid: chat.parentCommunityJid ?? existing.parentCommunityJid,
              }
            : {
                ...chat,
                kind: chat.kind ?? existing?.kind,
                parentCommunityJid: chat.parentCommunityJid ?? existing?.parentCommunityJid,
              };
        this.chats.set(chat.jid, next);
        this.writeChat(next);
      }
    });
    tx(chats);
  }

  /**
   * Replace a group's full participant roster. Does NOT mark days dirty — a
   * roster change alone re-renders lazily on the next message for that chat.
   */
  updateGroupRoster(jid: string, participants: string[]): void {
    const existing = this.chats.get(jid);
    const next: StoredChat = existing
      ? { ...existing, participants: [...participants], participantsFetchedAt: nowSeconds() }
      : {
          jid,
          name: jid,
          isGroup: jid.endsWith("@g.us"),
          participants: [...participants],
          participantsFetchedAt: nowSeconds(),
        };
    this.chats.set(jid, next);
    this.writeChat(next);
  }

  updateGroupRosters(rosters: Map<string, string[]> | Record<string, string[]>): void {
    const entries = rosters instanceof Map ? [...rosters.entries()] : Object.entries(rosters);
    const tx = this.db.transaction((items: [string, string[]][]) => {
      for (const [jid, participants] of items) this.updateGroupRoster(jid, participants);
    });
    tx(entries);
    if (entries.length > 0) log.debug(`Updated rosters for ${entries.length} groups`);
  }

  addGroupParticipants(jid: string, participantJids: string[]): void {
    const existing = this.chats.get(jid);
    const set = new Set(existing?.participants ?? []);
    for (const p of participantJids) set.add(p);
    const next: StoredChat = {
      jid,
      name: existing?.name ?? jid,
      isGroup: existing?.isGroup ?? jid.endsWith("@g.us"),
      kind: existing?.kind,
      parentCommunityJid: existing?.parentCommunityJid,
      participants: [...set],
      participantsFetchedAt: nowSeconds(),
    };
    this.chats.set(jid, next);
    this.writeChat(next);
  }

  removeGroupParticipants(jid: string, participantJids: string[]): void {
    const existing = this.chats.get(jid);
    if (!existing?.participants) return;
    const remove = new Set(participantJids);
    const next: StoredChat = {
      ...existing,
      participants: existing.participants.filter((p) => !remove.has(p)),
      participantsFetchedAt: nowSeconds(),
    };
    this.chats.set(jid, next);
    this.writeChat(next);
  }

  addContacts(contacts: StoredContact[]): void {
    if (contacts.length === 0) return;
    const tx = this.db.transaction((batch: StoredContact[]) => {
      for (const contact of batch) {
        const existing = this.contacts.get(contact.jid);
        const merged: StoredContact = existing
          ? {
              ...existing,
              ...contact,
              // Prefer non-empty values so a later partial event (e.g. a
              // pushName-only update) doesn't wipe a saved address-book name.
              name: contact.name || existing.name,
              pushName: contact.pushName ?? existing.pushName,
              phoneNumber: contact.phoneNumber ?? existing.phoneNumber,
              lid: contact.lid ?? existing.lid,
              verifiedName: contact.verifiedName ?? existing.verifiedName,
              username: contact.username ?? existing.username,
            }
          : contact;
        this.contacts.set(contact.jid, merged);
        this.writeContact(merged);

        const mapping = deriveLidMapping(merged);
        if (mapping) this.recordLidPhone(mapping[0], mapping[1]);
      }
    });
    tx(contacts);
  }

  // ───────────────────────────── lid → phone map ────────────────────────────

  /**
   * Conflict-aware LID→phone write. If the LID is already mapped to a DIFFERENT
   * phone, WhatsApp's unstable mapping has given two answers — mark the LID
   * contested (drop its mapping, never derive a phone for it again) instead of
   * trusting either. The downstream resolver then sees a LID-only mention and
   * can't fuse a stranger's phone onto a person. First write or an idempotent
   * re-write of the same phone just sets the map.
   */
  private recordLidPhone(lidUser: string, phone: string): void {
    if (!lidUser || !phone) return;
    if (this._contestedLids.has(lidUser)) return;
    const existing = this._lidPhoneMap.get(lidUser);
    if (existing !== undefined && existing !== phone) {
      this._contestedLids.add(lidUser);
      this._lidPhoneMap.delete(lidUser);
      this.stmts.deleteLid.run(lidUser);
      this.stmts.insertContested.run(lidUser);
      log.warn(`Contested WhatsApp LID ${lidUser}: maps to >1 phone — emitting LID-only`);
      return;
    }
    this._lidPhoneMap.set(lidUser, phone);
    this.stmts.upsertLid.run(lidUser, phone);
  }

  setLIDPhone(lid: string, phone: string): void {
    this.recordLidPhone(bareLid(lid), phone);
  }

  setLIDPhoneFromPn(lid: string, pn: string): void {
    const e164 = pnToE164(pn);
    if (!e164) return;
    this.recordLidPhone(bareLid(lid), e164);
  }

  hasLIDPhone(lid: string): boolean {
    return this._lidPhoneMap.has(bareLid(lid));
  }

  collectUnmappedLidJids(): string[] {
    const out = new Set<string>();
    const consider = (raw: string | undefined): void => {
      if (!raw || !raw.endsWith("@lid")) return;
      if (this._lidPhoneMap.has(bareLid(raw))) return;
      if (this._contestedLids.has(bareLid(raw))) return; // untrusted — don't re-map
      out.add(`${bareLid(raw)}@lid`);
    };
    for (const chat of this.chats.values()) {
      for (const member of chat.participants ?? []) consider(member);
    }
    for (const contact of this.contacts.values()) {
      consider(contact.lid);
      consider(contact.jid);
    }
    return [...out];
  }

  get lidPhoneMap(): Map<string, string> {
    return this._lidPhoneMap;
  }

  // ───────────────────────────── edits / deletes ────────────────────────────

  markDeleted(chatJid: string, messageId: string, timestamp: number): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT ts FROM messages WHERE chat_jid = ? AND id = ?`)
        .get(chatJid, messageId) as { ts: number } | undefined;
      this.stmts.markDeleted.run(chatJid, messageId);
      if (row) this.markDirtyRow(chatJid, messageDate(row.ts));
      // Mark the day implied by the event timestamp too, in case the message
      // itself never arrived (belt-and-suspenders for clock skew).
      this.markDirtyRow(chatJid, messageDate(timestamp));
    });
    tx();
    this.changeHandler?.();
  }

  updateMessage(chatJid: string, messageId: string, newText: string): void {
    const row = this.db
      .prepare(`SELECT ts FROM messages WHERE chat_jid = ? AND id = ?`)
      .get(chatJid, messageId) as { ts: number } | undefined;
    if (!row) return;
    const tx = this.db.transaction(() => {
      this.stmts.updateText.run(newText, chatJid, messageId);
      this.markDirtyRow(chatJid, messageDate(row.ts));
    });
    tx();
    this.changeHandler?.();
  }

  // ────────────────────────────────── drain ─────────────────────────────────

  /**
   * Drain up to `limit` pending dirty day-chats and return their messages
   * (queried from the durable archive — the complete day, not just new
   * arrivals). Non-destructive: stamps the drained rows with a fresh
   * `emit_seq` and returns it as `emitSeq`. The caller threads `emitSeq` into
   * the cursor's `committedSeq`; the NEXT drain (with the gateway-confirmed
   * `committedSeq`) clears the rows that landed. See the class doc for the
   * commit-gating contract.
   */
  drain(opts?: { limit?: number; committedSeq?: number }): {
    dirtyKeys: Set<string>;
    messagesByKey: Map<string, StoredMessage[]>;
    chats: Map<string, StoredChat>;
    contacts: Map<string, StoredContact>;
    lidPhoneMap: Map<string, string>;
    emitSeq: number;
    morePending: boolean;
  } {
    const candidate = opts?.committedSeq ?? 0;
    const committedSeq =
      Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= this.emitSeqCounter
        ? candidate
        : 0;
    const limit = opts?.limit ?? DEFAULT_DRAIN_LIMIT;

    // 1. Clear rows the gateway has confirmed committed (emit_seq advanced past
    //    on the prior page). Idempotent; safe to run every cycle.
    this.db
      .prepare(`DELETE FROM dirty_days WHERE emit_seq IS NOT NULL AND emit_seq <= ?`)
      .run(committedSeq);

    // 2. Select this page's pending rows (+1 to detect more) and detect overflow.
    const pendingRows = this.db
      .prepare(
        `SELECT chat_jid, date FROM dirty_days
         WHERE emit_seq IS NULL OR emit_seq > ?
         ORDER BY date ASC LIMIT ?`,
      )
      .all(committedSeq, limit + 1) as { chat_jid: string; date: string }[];
    const morePending = pendingRows.length > limit;
    const page = pendingRows.slice(0, limit);

    // 3. Stamp the page with a fresh emit_seq (persist the counter).
    const emitSeq = ++this.emitSeqCounter;
    const stamp = this.db.prepare(
      `UPDATE dirty_days SET emit_seq = ? WHERE chat_jid = ? AND date = ?`,
    );
    const selectDay = this.db.prepare(
      `SELECT * FROM messages WHERE chat_jid = ? AND ts >= ? AND ts < ? AND deleted = 0 ORDER BY ts ASC`,
    );

    const dirtyKeys = new Set<string>();
    const messagesByKey = new Map<string, StoredMessage[]>();

    const tx = this.db.transaction(() => {
      for (const { chat_jid, date } of page) {
        stamp.run(emitSeq, chat_jid, date);
        const key = `${chat_jid}:${date}`;
        dirtyKeys.add(key);
        const [start, end] = dayRange(date);
        const rows = selectDay.all(chat_jid, start, end) as MessageRow[];
        if (rows.length > 0)
          messagesByKey.set(
            key,
            rows.map((r) => this.rowToMessage(r)),
          );
      }
      this.setMeta("emit_seq_counter", String(this.emitSeqCounter));
    });
    tx();

    return {
      dirtyKeys,
      messagesByKey,
      chats: this.chats,
      contacts: this.contacts,
      lidPhoneMap: this._lidPhoneMap,
      emitSeq,
      morePending,
    };
  }

  private rowToMessage(r: MessageRow): StoredMessage {
    return {
      id: r.id,
      chatJid: r.chat_jid,
      senderJid: r.sender_jid,
      senderName: r.sender_name,
      fromMe: !!r.from_me,
      timestamp: r.ts,
      type: r.type,
      text: r.text,
      media: r.media_json ? safeJsonParse(r.media_json, undefined) : undefined,
      reactionEmoji: r.reaction_emoji ?? undefined,
      reactionTargetId: r.reaction_target_id ?? undefined,
      quotedText: r.quoted_text ?? undefined,
      quotedSender: r.quoted_sender ?? undefined,
      deleted: !!r.deleted,
      transcript: r.transcript ?? undefined,
      mediaState: (r.media_state as StoredMessage["mediaState"]) ?? undefined,
      mediaNextAttempt: r.media_next_attempt ?? undefined,
    };
  }

  /**
   * Re-mark every day that has messages as dirty, so a forced resync re-emits
   * the whole archive. Paginated by `drain()` like any other dirty set.
   */
  markAllDirty(): void {
    this.db
      .prepare(
        `INSERT INTO dirty_days (chat_jid, date)
         SELECT DISTINCT chat_jid, strftime('%Y-%m-%d', ts, 'unixepoch')
         FROM messages WHERE deleted = 0
         ON CONFLICT(chat_jid, date) DO UPDATE SET emit_seq = NULL`,
      )
      .run();
    log.info(`Marked all days dirty for resync (${this.dirtyCount} pending)`);
  }

  /**
   * Re-enroll every media message into the retry lifecycle (`pending`, due now),
   * so a resync reprocesses the whole archive — re-transcribing voice notes with
   * the current model and re-extracting attachments. Existing transcripts are
   * preserved by `recordMediaOutcome` if a re-download fails, so a resync never
   * loses data. No-key media that can't be fetched self-resolves to
   * `unavailable` on its first attempt (see the source's attempt guard).
   */
  resetMediaForResync(): void {
    const info = this.db
      .prepare(
        `UPDATE messages
         SET media_state = 'pending', media_attempts = 0,
             media_next_attempt = 0, media_last_error = NULL
         WHERE type IN ('audio', 'image', 'document') AND media_json IS NOT NULL AND deleted = 0`,
      )
      .run();
    log.info(`Reset ${info.changes} media messages for resync reprocessing`);
    this.scheduleNextMediaRetry();
  }

  /**
   * Record the outcome of one media download/processing attempt and advance the
   * lifecycle (see {@link MediaOutcome}): a success caches the result and clears
   * the retry; a transient failure backs off (or, once attempts are exhausted,
   * becomes terminal); a terminal failure marks the media `unavailable`. State
   * changes that affect rendering re-dirty the message's day so the result (or
   * the `unavailable` placeholder) propagates even if the day was already
   * emitted. A transient failure does NOT re-dirty — the retry sweep re-dirties
   * it when its backoff elapses, which avoids a tight re-emit loop.
   *
   * @param now Unix seconds; injectable so tests don't depend on wall-clock.
   */
  recordMediaOutcome(
    chatJid: string,
    id: string,
    outcome: MediaOutcome,
    now: number = nowSeconds(),
  ): void {
    const tx = this.db.transaction(() => {
      const prior = this.db
        .prepare(
          `SELECT media_state AS s, media_attempts AS a FROM messages WHERE chat_jid = ? AND id = ?`,
        )
        .get(chatJid, id) as { s: string | null; a: number } | undefined;
      if (!prior) return; // message gone (e.g. deleted mid-sync)

      let newState: MediaState;
      // Whether the result must reach a re-emit. Inline-rendered results
      // (an attachment extracted during this same drain) are already in the
      // emitted doc, so re-dirtying would only spin a wasteful re-extract;
      // a transcript may be persisted out-of-band, and an `unavailable`
      // placeholder isn't reflected until a re-render, so those re-dirty.
      let needsReemit: boolean;
      switch (outcome.kind) {
        case "transcribed": {
          newState = outcome.text === "" ? "empty" : "done";
          this.db
            .prepare(
              `UPDATE messages SET media_state = ?, transcript = ?,
                 media_next_attempt = NULL, media_last_error = NULL
               WHERE chat_jid = ? AND id = ?`,
            )
            .run(newState, outcome.text, chatJid, id);
          needsReemit = newState !== prior.s;
          break;
        }
        case "extracted": {
          // Attachment text is rendered inline in this same drain, so the
          // result never needs a re-emit and `newState` isn't read here.
          this.db
            .prepare(
              `UPDATE messages SET media_state = 'done',
                 media_next_attempt = NULL, media_last_error = NULL
               WHERE chat_jid = ? AND id = ?`,
            )
            .run(chatJid, id);
          needsReemit = false; // attachment text is rendered inline this drain
          break;
        }
        case "empty": {
          this.db
            .prepare(
              `UPDATE messages SET media_state = 'empty',
                 media_next_attempt = NULL, media_last_error = NULL
               WHERE chat_jid = ? AND id = ?`,
            )
            .run(chatJid, id);
          needsReemit = false; // no-text status is rendered inline this drain
          break;
        }
        case "transient":
        case "process-failed":
        case "terminal": {
          const attempts = prior.a + 1;
          // `terminal` gives up now; `transient` (a download failure) gives up
          // once the backoff is exhausted (CDN media truly expires);
          // `process-failed` (bytes in hand, capability missing) retries
          // forever at the capped interval and never becomes unavailable.
          const delay =
            outcome.kind === "terminal"
              ? null
              : outcome.kind === "process-failed"
                ? this.cappedRetryDelaySec(attempts)
                : computeMediaRetryDelaySec(attempts, this.retryPolicy);
          const giveUp = delay === null;
          newState = giveUp ? "unavailable" : "pending";
          this.db
            .prepare(
              `UPDATE messages SET media_state = ?, media_attempts = ?,
                 media_last_attempt = ?, media_next_attempt = ?, media_last_error = ?
               WHERE chat_jid = ? AND id = ?`,
            )
            .run(newState, attempts, now, giveUp ? null : now + delay!, outcome.error, chatJid, id);
          if (giveUp) {
            log.warn(
              `Media for ${chatJid}/${id} marked unavailable after ${attempts} attempt(s): ${outcome.error}`,
            );
          }
          // Surface the `unavailable` placeholder on the next render; a
          // still-`pending` backoff doesn't re-dirty (the retry sweep re-dirties
          // it when its backoff elapses, which avoids a tight re-emit loop).
          needsReemit = newState === "unavailable" && prior.s !== "unavailable";
          break;
        }
        default:
          assertNever(outcome);
      }

      if (needsReemit) this.dirtyDayForMessage(chatJid, id);
    });
    tx();
    // A new/changed `media_next_attempt` may move the earliest due time.
    this.scheduleNextMediaRetry();
  }

  /**
   * Postpone overdue durable-media rows that the source did not admit into
   * this page's processing budget. This is scheduling, not a failed attempt:
   * state, attempt count, and last error remain untouched. Moving the due time
   * forward lets a committed old day clear before the retry sweep re-dirties it,
   * so a large enrichment backlog cannot crowd recent primary messages out of
   * the oldest-first drain indefinitely.
   */
  deferMediaAttempts(items: readonly { chatJid: string; id: string }[], now = nowSeconds()): void {
    if (items.length === 0) return;
    const nextAttempt = now + MEDIA_RETRY_OVERDUE_RECHECK_MS / 1000;
    const defer = this.db.prepare(
      `UPDATE messages SET media_next_attempt = ?
       WHERE chat_jid = ? AND id = ? AND media_state = 'pending'`,
    );
    const tx = this.db.transaction(() => {
      for (const { chatJid, id } of items) defer.run(nextAttempt, chatJid, id);
    });
    tx();
    this.scheduleNextMediaRetry();
  }

  /** Backoff delay that never gives up — used for `process-failed` retries. */
  private cappedRetryDelaySec(attempts: number): number {
    const sched = this.retryPolicy.backoffSec;
    return sched[Math.min(Math.max(attempts - 1, 0), sched.length - 1)];
  }

  /**
   * Persist a voice note's transcript. Thin wrapper over `recordMediaOutcome`;
   * `""` is a valid value (transcribed, no speech detected → `empty`).
   */
  setTranscript(chatJid: string, id: string, transcript: string): void {
    this.recordMediaOutcome(chatJid, id, { kind: "transcribed", text: transcript });
  }

  /** Re-dirty a message's day (no-op if the message is gone). */
  private dirtyDayForMessage(chatJid: string, id: string): void {
    const row = this.db
      .prepare(`SELECT ts FROM messages WHERE chat_jid = ? AND id = ?`)
      .get(chatJid, id) as { ts: number } | undefined;
    if (row) this.markDirtyRow(chatJid, messageDate(row.ts));
  }

  /**
   * The retry sweep: re-dirty the days of `pending` media whose backoff window
   * has elapsed, so the next `drain()` re-renders them and the source retries
   * the download. This is what decouples retries from chat activity — a failed
   * voice note on a past day gets retried on schedule, not only if someone
   * happens to message that day again. Returns how many days were re-dirtied.
   *
   * @param now Unix seconds (injectable for tests).
   * @param limit Max due day-chats to re-arm per sweep, bounding the re-emit burst.
   */
  markDueMediaDirty(now: number = nowSeconds(), limit = DEFAULT_DRAIN_LIMIT): number {
    const due = this.db
      .prepare(
        `SELECT DISTINCT chat_jid, strftime('%Y-%m-%d', ts, 'unixepoch') AS date
         FROM messages
         WHERE ${MEDIA_RETRY_ELIGIBILITY} AND media_next_attempt <= @now
         LIMIT @limit`,
      )
      .all({ ...this.mediaRetryScope, now, limit }) as { chat_jid: string; date: string }[];
    if (due.length === 0) return 0;
    const tx = this.db.transaction(() => {
      for (const { chat_jid, date } of due) this.markDirtyRow(chat_jid, date);
    });
    tx();
    return due.length;
  }

  /**
   * Pull every `pending` media's next attempt forward to now, so the next sweep
   * retries it immediately. Called when the WhatsApp socket (re)connects: the
   * phone is freshly reachable, which is the best moment to recover media that
   * needs a device to re-upload it. Returns how many were pulled forward.
   */
  pullForwardMediaRetries(): number {
    const info = this.db
      .prepare(`UPDATE messages SET media_next_attempt = 0 WHERE media_state = 'pending'`)
      .run();
    // Wake a sync so the sweep picks them up now rather than at the next poll.
    if (info.changes > 0) this.changeHandler?.();
    this.scheduleNextMediaRetry();
    return info.changes;
  }

  /** Counts of media by lifecycle state — for the per-sync health summary log. */
  mediaHealthStats(): { pending: number; unavailable: number } {
    const rows = this.db
      .prepare(
        `SELECT media_state AS s, COUNT(*) AS n FROM messages
         WHERE media_state IN ('pending', 'unavailable') GROUP BY media_state`,
      )
      .all() as { s: string; n: number }[];
    const by = new Map(rows.map((r) => [r.s, r.n]));
    return { pending: by.get("pending") ?? 0, unavailable: by.get("unavailable") ?? 0 };
  }

  // ──────────────────────────────── lookups ─────────────────────────────────

  /**
   * Fetch a single stored message by its `(chatJid, id)` key. Backs the
   * Baileys `getMessage` hook so the socket can answer message-retry and
   * decryption requests from our durable archive.
   */
  getMessageById(chatJid: string, id: string): StoredMessage | undefined {
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE chat_jid = ? AND id = ?`)
      .get(chatJid, id) as MessageRow | undefined;
    return row ? this.rowToMessage(row) : undefined;
  }

  getChat(jid: string): StoredChat | undefined {
    return this.chats.get(jid);
  }

  getContact(jid: string): StoredContact | undefined {
    return this.contacts.get(jid);
  }

  /** Total messages in the durable archive (debug / tests). */
  get totalMessages(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM messages`).get() as { c: number }).c;
  }

  /**
   * Chats WhatsApp has told us about, whether or not their messages arrived.
   *
   * The chat list reaches a linked device long before message history does, so
   * this separates "the account is empty" from "the history push has not
   * delivered". Sealing a history sync complete on silence is only honest for
   * the first.
   */
  get totalChats(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM chats`).get() as { c: number }).c;
  }

  /** Pending (never-drained) dirty day-chats — used for logging only. */
  get dirtyCount(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM dirty_days WHERE emit_seq IS NULL`).get() as {
        c: number;
      }
    ).c;
  }

  setChatKind(jid: string, kind: ChatKind, parentCommunityJid?: string): void {
    const existing = this.chats.get(jid) ?? { jid, name: jid, isGroup: true };
    const next: StoredChat = {
      ...existing,
      kind,
      parentCommunityJid: parentCommunityJid ?? existing.parentCommunityJid,
    };
    this.chats.set(jid, next);
    this.writeChat(next);
  }

  // ────────────────────────────── lifecycle ─────────────────────────────────

  /** Force a WAL checkpoint (e.g. before a long idle period). */
  flush(): void {
    try {
      this.db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      /* best-effort */
    }
  }

  /** Close the DB handle. MUST run before the account dir is removed. */
  close(): void {
    if (this.mediaRetryTimer) {
      clearTimeout(this.mediaRetryTimer);
      this.mediaRetryTimer = undefined;
    }
    try {
      this.db.close();
    } catch (err) {
      log.warn(`store.db close failed: ${toErrorMessage(err)}`);
    }
  }

  // ────────────────────────────── migration ─────────────────────────────────

  /**
   * One-shot import of the legacy `message-store.json` blob, then delete it.
   * Imports chats, contacts AND the residue messages (marked dirty so they
   * re-emit — residue can be never-emitted messages that exist only in the
   * JSON; dropping them would be silent loss). Maps the legacy
   * `historySyncComplete` boolean to the tri-state (true→complete,
   * false→interrupted — never silently `complete`, which would wrongly re-seal).
   * Gated on an absent `meta.user_version`, so it's a permanent no-op after the
   * first run and the branch is safely removable in a later release.
   */
  private maybeMigrateFromJson(): void {
    if (!this.dir) return;
    if (this.getMeta("user_version")) return; // already migrated / fresh-stamped
    const jsonPath = join(this.dir, "message-store.json");
    if (!existsSync(jsonPath)) {
      this.setMeta("user_version", String(SCHEMA_VERSION));
      return;
    }
    try {
      const state: LegacyPersistedState = JSON.parse(readFileSync(jsonPath, "utf-8"));
      const tx = this.db.transaction(() => {
        for (const chat of Object.values(state.chats ?? {})) this.writeChat(chat);
        for (const contact of Object.values(state.contacts ?? {})) {
          this.writeContact(contact);
          const mapping = deriveLidMapping(contact);
          if (mapping) this.stmts.upsertLid.run(mapping[0], mapping[1]);
        }
        // RAM maps aren't loaded yet during migration, so ensure chat rows and
        // backfill anchors directly via SQL — INSERT OR IGNORE never clobbers a
        // real chat row already written from state.chats above.
        const ensureChatStub = this.db.prepare(
          `INSERT OR IGNORE INTO chats (jid, name, is_group) VALUES (?, ?, ?)`,
        );
        let imported = 0;
        for (const byId of Object.values(state.messages ?? {})) {
          for (const m of Object.values(byId)) {
            ensureChatStub.run(m.chatJid, m.chatJid, m.chatJid.endsWith("@g.us") ? 1 : 0);
            this.stmts.insertMessage.run(this.messageParams(m));
            if (!m.deleted) this.markDirtyRow(m.chatJid, messageDate(m.timestamp));
            imported++;
          }
        }
        this.setMeta("history_sync_state", state.historySyncComplete ? "complete" : "interrupted");
        this.setMeta("user_version", String(SCHEMA_VERSION));
        log.info(`Migrated legacy message-store.json: ${imported} residue messages imported`);
      });
      tx();
      rmSync(jsonPath, { force: true });
    } catch (err) {
      log.warn(`Legacy JSON migration failed, starting fresh: ${toErrorMessage(err)}`);
      this.setMeta("user_version", String(SCHEMA_VERSION));
    }
  }
}
