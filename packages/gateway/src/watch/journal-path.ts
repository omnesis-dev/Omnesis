// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where the watch journal lives, and how an install that predates the name
 * gets there.
 *
 * The engine used to be the second of two and its journal was called
 * `watch2.db`. The file is renamed on the first boot that finds it, once, and
 * every boot after that is a handful of `stat` calls. This module is the only
 * place the old name appears.
 *
 * Three things make the move less trivial than a rename:
 *
 *   - **The WAL is not optional.** A SQLite database mid-transaction keeps
 *     committed pages in a `-wal` sidecar. Moving the main file alone does not
 *     lose a few rows — the result does not open at all. So the journal is
 *     folded back into the main file and the sidecars are proven gone before
 *     anything moves.
 *   - **Two files that both look authoritative is worse than one.** If both
 *     names exist, this refuses rather than guessing, unless the old one
 *     provably holds nothing — and even then it is moved aside, never deleted.
 *   - **The storage key keeps its old name on purpose.** `watch2-db` is the
 *     label the key envelope is sealed under, in four places; the bytes are
 *     random, so the same key opens the same data under either filename. See
 *     the comment on `STORAGE_KEY_NAMES` for why renaming it is unsafe.
 */

import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger, WATCH_JOURNAL_FILENAME, type Logger } from "@omnesis/core";
import {
  cleanStaleEncryptTemps,
  fsyncDir,
  fsyncFile,
  openEncryptedSqlite,
  sqliteFileLooksPlaintext,
} from "../sqlite-encryption.js";

const log: Logger = createLogger("gateway").child("watch:journal");

export { WATCH_JOURNAL_FILENAME };

/** The name the journal had while this engine was the second of two. */
const LEGACY_WATCH_JOURNAL_FILENAME = "watch2.db";

/**
 * The sidecars that carry committed data. A database moved without these does
 * not open at all, so their absence is asserted before anything is renamed.
 */
const DATA_SIDECAR_SUFFIXES = ["-wal", "-journal"] as const;

/**
 * The shared-memory index into the write-ahead log. Holds nothing durable and
 * is rebuilt on demand, so a stale one is swept aside rather than treated as a
 * reason to refuse — a database whose WAL is folded has no use for it.
 */
const DERIVED_SIDECAR_SUFFIXES = ["-shm"] as const;

const SIDECAR_SUFFIXES = [...DATA_SIDECAR_SUFFIXES, ...DERIVED_SIDECAR_SUFFIXES] as const;

export function watchJournalPath(configDir: string): string {
  return join(configDir, WATCH_JOURNAL_FILENAME);
}

export type WatchJournalResolution =
  | {
      readonly ok: true;
      readonly path: string;
      /** Whether this boot moved a legacy journal into place. */
      readonly adopted: boolean;
      /**
       * Whether a journal existed before this boot.
       *
       * False on a fresh install, and the reason it is reported: a journal
       * that has never held a watch lists none, which is a different fact from
       * an operator having removed them all. Callers that would act on
       * emptiness have to be able to tell those apart.
       */
      readonly existed: boolean;
    }
  | { readonly ok: false; readonly path: string; readonly reason: string };

/**
 * Settle on the journal's path, moving a legacy one into place if that is what
 * the config dir holds.
 *
 * Must run before anything opens the journal, and after the storage key is
 * available — an encrypted legacy file cannot be folded without it.
 */
export function resolveWatchJournal(configDir: string, key: Buffer | null): WatchJournalResolution {
  const target = watchJournalPath(configDir);
  const legacy = join(configDir, LEGACY_WATCH_JOURNAL_FILENAME);

  try {
    if (!existsSync(legacy)) {
      const existed = existsSync(target);
      // A sidecar with no database beside it belongs to a file that is gone.
      // Opening a fresh journal over someone else's WAL is not recoverable, so
      // it is moved out of the way rather than inherited.
      if (!existed) moveSidecarsAside(target, "orphan", "warn");
      return { ok: true, path: target, adopted: false, existed };
    }

    if (existsSync(target)) {
      if (!legacyIsProvablyEmpty(legacy, key)) {
        return { ok: false, path: target, reason: bothFilesReason(legacy, target) };
      }
      // The dominant cause of this state is a downgrade: an older build opened
      // the missing old name and created an empty file. Moving it aside is
      // safe precisely because it was proven to hold nothing.
      const aside = `${legacy}.superseded-${stamp()}`;
      renameSync(legacy, aside);
      log.info(`an empty ${LEGACY_WATCH_JOURNAL_FILENAME} was set aside as ${aside}`);
      return { ok: true, path: target, adopted: false, existed: true };
    }

    const folded = foldLegacyWal(legacy, key);
    if (folded !== null) return { ok: false, path: target, reason: folded };

    // Swept first: a folded database has no use for a shared-memory index, and
    // leaving one beside the old name would strand it there forever.
    moveSidecarsAside(legacy, "stale", "warn", DERIVED_SIDECAR_SUFFIXES);
    const stillThere = DATA_SIDECAR_SUFFIXES.filter((s) => existsSync(`${legacy}${s}`));
    if (stillThere.length > 0) {
      return {
        ok: false,
        path: target,
        reason: `${legacy} still has ${stillThere.join(", ")} after checkpointing; moving the database without them would lose committed writes`,
      };
    }

    fsyncFile(legacy);
    renameSync(legacy, target);
    fsyncDir(configDir);

    // A sidecar that came back means another process wrote through the window
    // between closing the file and moving it. Loud, because it is evidence of
    // a second gateway rather than an ordinary state.
    moveSidecarsAside(legacy, "orphan", "error");
    // Keyed off the old basename, so nothing would ever reap these again once
    // the name changes — and on an encrypted install they are plaintext.
    cleanStaleEncryptTemps(legacy);

    log.info(`adopted ${LEGACY_WATCH_JOURNAL_FILENAME} as ${WATCH_JOURNAL_FILENAME}`);
    return { ok: true, path: target, adopted: true, existed: true };
  } catch (err) {
    return { ok: false, path: target, reason: explain(err) };
  }
}

/**
 * Fold the legacy journal's WAL back into it and leave it with no sidecars.
 *
 * Returns null on success, or a sentence naming what stopped it. Taking the
 * exclusive lock is how a second gateway is detected: it throws before
 * mutating anything, leaving the file byte-identical.
 */
function foldLegacyWal(legacy: string, key: Buffer | null): string | null {
  const plaintext = sqliteFileLooksPlaintext(legacy);
  if (!plaintext && !key) {
    return `${legacy} is encrypted but no storage key is available to fold its write-ahead log`;
  }

  // `migratePlaintext: false` is load-bearing rather than defensive: encrypting
  // in place ends in a rename back onto this same path, which is how a
  // migration could manufacture the two-file state this module exists to
  // refuse. A plaintext journal on an armed install is encrypted afterwards by
  // the ordinary opener, at the new name.
  const db = plaintext
    ? openEncryptedSqlite(legacy, { key: null })
    : openEncryptedSqlite(legacy, { key, migratePlaintext: false });
  try {
    db.pragma("busy_timeout = 30000");
    db.pragma("locking_mode = EXCLUSIVE");
    // Both takes the lock and proves the key: SQLCipher validates lazily, and a
    // checkpoint over an empty WAL can complete without ever reading page 1.
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    // Belt to `journal_mode = DELETE`'s braces. Switching modes is what folds
    // the log — verified by removing this line and watching nothing redden —
    // but a checkpoint first keeps the mode switch from doing unbounded work
    // while holding the exclusive lock.
    db.pragma("wal_checkpoint(TRUNCATE)");
    const mode = db.pragma("journal_mode = DELETE") as { journal_mode?: string }[];
    const settled = mode[0]?.journal_mode;
    // Asserted rather than assumed. A driver that no-ops here instead of
    // throwing would leave the WAL behind to be stranded by the rename, which
    // is the exact loss this function exists to prevent.
    if (settled !== "delete") {
      return `${legacy} would not leave write-ahead mode (journal_mode reported ${String(settled)})`;
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * Whether the legacy file demonstrably holds no watches.
 *
 * Only true for a file that is readable and empty. Anything unreadable answers
 * false, because "I could not tell" must resolve the same way as "it has data".
 */
function legacyIsProvablyEmpty(legacy: string, key: Buffer | null): boolean {
  const plaintext = sqliteFileLooksPlaintext(legacy);
  if (!plaintext && !key) return false;
  try {
    const db = plaintext
      ? openEncryptedSqlite(legacy, { key: null, readonly: true })
      : openEncryptedSqlite(legacy, { key, readonly: true, migratePlaintext: false });
    try {
      const tables = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('watch_events', 'watch_defs')",
        )
        .all()
        .map((r) => r.name);
      for (const table of tables) {
        const row = db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get();
        if ((row?.n ?? 0) > 0) return false;
      }
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function moveSidecarsAside(
  base: string,
  label: string,
  level: "warn" | "error",
  suffixes: readonly string[] = SIDECAR_SUFFIXES,
): void {
  for (const suffix of suffixes) {
    const path = `${base}${suffix}`;
    if (!existsSync(path)) continue;
    const aside = `${path}.${label}-${stamp()}`;
    renameSync(path, aside);
    log[level](`moved a stranded ${suffix} sidecar aside: ${path} → ${aside}`);
  }
}

function bothFilesReason(legacy: string, target: string): string {
  const describe = (p: string): string => {
    try {
      const s = statSync(p);
      return `${p} (${s.size} bytes, modified ${new Date(s.mtimeMs).toISOString()})`;
    } catch {
      return p;
    }
  };
  return (
    `${describe(legacy)} and ${describe(target)} both hold watch data. ` +
    "Nothing was moved or merged. Keep whichever is the one you want, move the " +
    `other out of the config directory, and start again — only ${WATCH_JOURNAL_FILENAME} is read.`
  );
}

function explain(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EBUSY") {
    return `${message} — the config directory may be a bind mount; rename cannot proceed while it is held`;
  }
  if (code === "EACCES" || code === "EPERM") {
    return `${message} — the gateway cannot write the config directory`;
  }
  return message;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
