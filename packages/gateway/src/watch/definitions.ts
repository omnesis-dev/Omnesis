// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The watches the hosted runtime is running, and the shape they arrived in.
 *
 * A watch is data. Nothing here compiles one and nothing here decides what one
 * means: the DSL is validated against the live ontology when it is stored, and
 * stored verbatim. A definition whose ontology has since moved is **paused**,
 * never reinterpreted — a watch that quietly means something else is no longer
 * the watch the operator approved.
 *
 * Kept in the journal beside the journal, for the same reason the journal is:
 * runtime-owned state whose shape is still moving, and the gateway's own schema
 * is on an append-only migration discipline that a moving shape would abuse.
 */

import { createLogger } from "@omnesis/core";
import type { WatchDelivery } from "@omnesis/watch";
import type { EncryptedSqliteDatabase } from "../sqlite-encryption.js";

const log = createLogger("gateway").child("watch-v2:definitions");

/** What the runtime does with a watch, and why. */
export type WatchStatus =
  /** Evaluated on every drain. */
  | "active"
  /** Held: the ontology it validated against has moved, or an operator paused it. */
  | "paused"
  /** Finished — `once_ever` fired, or the horizon passed. */
  | "retired";

export const WATCH_STATUSES: readonly WatchStatus[] = ["active", "paused", "retired"];

export interface StoredWatch {
  /** The runtime's identity for this watch. */
  readonly id: string;
  /** The name the DSL carries, for a person reading a list. */
  readonly name: string;
  readonly status: WatchStatus;
  /** The DSL exactly as it was accepted. */
  readonly dsl: unknown;
  readonly addedAt: string;
  /**
   * Where in the journal this watch began.
   *
   * A watch added today watches the future, not the corpus: it starts at the
   * journal head, because "tell me when someone emails about X" is a claim
   * about what happens next and a watch that woke on four years of history
   * would be answering a question nobody asked. `--from-seq` overrides it, for
   * a test that wants the past.
   */
  readonly fromSeq: number;
  /** Why it is paused, when it is. */
  readonly note: string | null;
  /**
   * The cognition run that compiled this watch — the handle onto the
   * transcript of what the compiler saw and answered.
   *
   * Kept on the watch rather than only on the subscription revision, because
   * most watches have no revision: only one that wakes an agent keeps a record
   * among the subscriptions, and an operator's notify-only watch would
   * otherwise have no path from the thing they installed to the reasoning that
   * produced it.
   *
   * Null for a watch installed by hand from a DSL document (nothing was
   * compiled), for one whose ledger write did not land, and for every watch
   * stored before this column existed.
   */
  readonly compileRunId: string | null;
  /**
   * The asker's own name for the request that installed this watch.
   *
   * Only an integration brings one — an operator's install is a person
   * clicking once — and it is what makes compiling and installing idempotent
   * rather than only the record at the end of them. Unique across the store,
   * so a retry that reached the install and failed after it converges on the
   * watch it already made instead of compiling a second copy of it.
   */
  readonly requestKey: string | null;
  /**
   * A hash over the slice of the ontology this watch's last successful
   * validation actually consulted.
   *
   * Host bookkeeping rather than part of the document: the operator approved a
   * watch, not a digest, and putting it in the DSL would make every install a
   * rewrite of the thing being installed. It exists to answer the one question
   * the install-wide fingerprint cannot — the fingerprint says *something*
   * moved, this says whether the part this watch reads did.
   *
   * Null for a watch that has not validated since the column existed, and
   * again after any rewrite of its DSL. Null means unproven, and unproven is
   * treated as changed.
   */
  readonly referenceDigest: string | null;
}

interface WatchRow {
  id: string;
  name: string;
  status: string;
  dsl_json: string;
  added_at: string;
  from_seq: number;
  note: string | null;
  compile_run_id: string | null;
  request_key: string | null;
  reference_digest: string | null;
}

/**
 * The same watch, carrying a different ontology fingerprint.
 *
 * Returned as a copy: the stored definition is only rewritten once the copy has
 * been validated, so a refusal leaves the original exactly as it was.
 *
 * Beside {@link WatchDefinitionStore.restamp} because they are two halves of
 * one operation — this builds what is checked, that writes what was accepted —
 * and two implementations of "the same watch with a new fingerprint" is how one
 * of them acquires a second edit nobody asked for.
 */
export function withFingerprint(dsl: unknown, fingerprint: string): unknown {
  const copy = JSON.parse(JSON.stringify(dsl)) as { watch?: Record<string, unknown> } | null;
  // Only where one already is. The fingerprint is optional, and a watch written
  // without one has opted out of the drift alarm; adding it here would arm an
  // alarm its author deliberately left off.
  if (copy?.watch && copy.watch["ontology_fingerprint"] !== undefined) {
    copy.watch["ontology_fingerprint"] = fingerprint;
  }
  return copy;
}

export class WatchDefinitionStore {
  constructor(private readonly db: EncryptedSqliteDatabase) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS watch_defs (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        status         TEXT NOT NULL,
        dsl_json       TEXT NOT NULL,
        added_at       TEXT NOT NULL,
        from_seq       INTEGER NOT NULL DEFAULT 0,
        note           TEXT,
        compile_run_id TEXT,
        request_key TEXT,
        reference_digest TEXT
      );
    `);
    // This store predates the column and is not under the main database's
    // numbered-migration discipline, so an install that has been running keeps
    // its table and gains the column here. Probed rather than blind, because
    // `ADD COLUMN` on a column that exists is an error rather than a no-op.
    const columns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('watch_defs')")
      .all()
      .map((row) => row.name);
    if (!columns.includes("compile_run_id")) {
      db.exec("ALTER TABLE watch_defs ADD COLUMN compile_run_id TEXT");
    }
    if (!columns.includes("request_key")) {
      db.exec("ALTER TABLE watch_defs ADD COLUMN request_key TEXT");
    }
    if (!columns.includes("reference_digest")) {
      db.exec("ALTER TABLE watch_defs ADD COLUMN reference_digest TEXT");
    }
    // After the column exists on both paths, never inside the CREATE batch: on
    // an install that already has this table the CREATE is a no-op and the
    // ALTER above is what supplies the column, so an index declared alongside
    // the table runs against a column that is not there yet. This store is
    // constructed at boot with nothing above it catching anything, so that is
    // a crash loop rather than a degraded start.
    //
    // Partial because most watches carry no key: SQLite treats NULLs as
    // distinct in a unique index either way, and saying so is what makes the
    // intent legible.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS watch_defs_request_key
         ON watch_defs (request_key) WHERE request_key IS NOT NULL`,
    );
  }

  /** Store a watch, replacing one of the same id. */
  put(watch: StoredWatch): void {
    this.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          string,
          number,
          string | null,
          string | null,
          string | null,
        ]
      >(
        `INSERT INTO watch_defs
           (id, name, status, dsl_json, added_at, from_seq, note, compile_run_id, request_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             status = excluded.status,
             dsl_json = excluded.dsl_json,
             from_seq = excluded.from_seq,
             note = excluded.note,
             compile_run_id = excluded.compile_run_id,
             request_key = excluded.request_key,
             -- Cleared rather than carried: this call may be replacing the DSL,
             -- and a digest describing the surface the *previous* document read
             -- would let the next drift auto-re-stamp a watch on the strength of
             -- a comparison against a watch that no longer exists. The next
             -- successful validation records the right one.
             reference_digest = NULL`,
      )
      .run(
        watch.id,
        watch.name,
        watch.status,
        JSON.stringify(watch.dsl),
        watch.addedAt,
        watch.fromSeq,
        watch.note,
        watch.compileRunId,
        watch.requestKey ?? null,
      );
  }

  /**
   * The watch an asker's own key already installed, if any.
   *
   * What makes compiling and installing idempotent, rather than only the
   * subscription record at the end of them. A caller whose request reached the
   * install and failed after it retries with the same key and has nothing to
   * deduplicate against downstream — there is no record yet — so without this
   * the retry compiles again and installs a second watch beside the first,
   * which then evaluates and spends judge budget forever.
   */
  findByRequestKey(requestKey: string): StoredWatch | null {
    const row = this.db
      .prepare<[string], WatchRow>("SELECT * FROM watch_defs WHERE request_key = ?")
      .get(requestKey);
    return row ? decode(row) : null;
  }

  get(id: string): StoredWatch | null {
    const row = this.db
      .prepare<[string], WatchRow>("SELECT * FROM watch_defs WHERE id = ?")
      .get(id);
    return row ? decode(row) : null;
  }

  /** Every watch, newest first. */
  list(): StoredWatch[] {
    return this.db
      .prepare<[], WatchRow>("SELECT * FROM watch_defs ORDER BY added_at DESC, id DESC")
      .all()
      .map(decode)
      .filter((watch): watch is StoredWatch => watch !== null);
  }

  /** The watches the runtime should evaluate this tick. */
  active(): StoredWatch[] {
    return this.list().filter((watch) => watch.status === "active");
  }

  /** Whether this accepted definition contains a semantic judge node. */
  requiresJudge(watch: StoredWatch): boolean {
    const root = watch.dsl as { watch?: { nodes?: unknown[] } } | null;
    return (
      root?.watch?.nodes?.some((raw) => {
        if (typeof raw !== "object" || raw === null) return false;
        const node = raw as { type?: unknown; judge?: unknown };
        return node.type === "llm" || node.judge !== undefined;
      }) ?? false
    );
  }

  remove(id: string): boolean {
    return this.db.prepare<[string]>("DELETE FROM watch_defs WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Record the ontology slice this watch was last validated against.
   *
   * Written after a validation that passed, so what it holds is always "the
   * surface the watch was last known to mean what it says against". A drift
   * that leaves this digest identical has left the watch's meaning identical;
   * one that moves it has not, whether or not the watch still validates.
   *
   * Every writer of `dsl_json` owes this a call or a clear, because a digest
   * describing the surface a *previous* document read would answer a later
   * drift about a watch that no longer exists. {@link put} clears it; the two
   * routes that rewrite one field of a stored document record the surface they
   * validated against, which is also the operator's approval of it.
   */
  recordReferenceDigest(id: string, digest: string): void {
    this.db
      .prepare<[string, string]>("UPDATE watch_defs SET reference_digest = ? WHERE id = ?")
      .run(digest, id);
  }

  /**
   * Record that this watch has been re-validated against a newer ontology.
   *
   * The fingerprint lives inside the DSL rather than in a column beside it, so
   * re-stamping means rewriting the stored document — and rewriting exactly one
   * field of it. Anything else changed here would be a different watch wearing
   * the history of the old one, which is the thing the fingerprint exists to
   * make impossible.
   */
  restamp(id: string, fingerprint: string): void {
    const row = this.db
      .prepare<[string], { dsl_json: string }>("SELECT dsl_json FROM watch_defs WHERE id = ?")
      .get(id);
    if (!row) return;
    const dsl = JSON.parse(row.dsl_json) as { watch?: Record<string, unknown> } | null;
    // Same tolerance the decoder has: a row this build cannot read is left
    // alone rather than throwing, so one of them cannot fail a bulk pass.
    if (!dsl?.watch || dsl.watch["ontology_fingerprint"] === undefined) return;
    dsl.watch["ontology_fingerprint"] = fingerprint;
    this.db
      .prepare<[string, string]>("UPDATE watch_defs SET dsl_json = ? WHERE id = ?")
      .run(JSON.stringify(dsl), id);
  }

  /**
   * Turn delivery on or off for an installed watch.
   *
   * The same shape as `restamp`, and for the same reason: delivery lives inside
   * the DSL, so changing it means rewriting the stored document and exactly one
   * field of it. Keeping it in the DSL rather than in a column beside it means
   * `watch2 show` describes the watch that is running — including whether it
   * will interrupt someone — rather than most of it.
   *
   * `null` clears the block entirely, which is what shadow means: the key is
   * removed rather than set to a "none" kind, so a definition with no delivery
   * reads exactly like one written without it.
   */
  setDelivery(id: string, delivery: WatchDelivery | null): boolean {
    const row = this.db
      .prepare<[string], { dsl_json: string }>("SELECT dsl_json FROM watch_defs WHERE id = ?")
      .get(id);
    if (!row) return false;
    const dsl = JSON.parse(row.dsl_json) as { watch?: Record<string, unknown> } | null;
    // Reported rather than swallowed: the caller answers an operator, and a
    // row this build cannot read is a no-op that must not be called a success.
    if (!dsl?.watch) return false;
    if (delivery === null) delete dsl.watch["delivery"];
    else dsl.watch["delivery"] = delivery;
    this.db
      .prepare<[string, string]>("UPDATE watch_defs SET dsl_json = ? WHERE id = ?")
      .run(JSON.stringify(dsl), id);
    return true;
  }

  setStatus(id: string, status: WatchStatus, note: string | null = null): void {
    this.db
      .prepare<
        [string, string | null, string]
      >("UPDATE watch_defs SET status = ?, note = ? WHERE id = ?")
      .run(status, note, id);
  }
}

/**
 * A stored row as a watch, or `null` when this build cannot read it.
 *
 * A definition written by a build whose DSL has since moved must not stop the
 * runtime loading every other watch: one unreadable row would otherwise take
 * the whole subsystem down on a downgrade.
 */
function decode(row: WatchRow): StoredWatch | null {
  const status = WATCH_STATUSES.includes(row.status as WatchStatus)
    ? (row.status as WatchStatus)
    : null;
  if (status === null) {
    log.warn(`watch ${row.id} has an unreadable status '${row.status}' and was skipped`);
    return null;
  }
  try {
    return {
      id: row.id,
      name: row.name,
      status,
      dsl: JSON.parse(row.dsl_json) as unknown,
      addedAt: row.added_at,
      fromSeq: row.from_seq,
      note: row.note,
      compileRunId: row.compile_run_id ?? null,
      requestKey: row.request_key ?? null,
      referenceDigest: row.reference_digest ?? null,
    };
  } catch {
    log.warn(`watch ${row.id} has an unreadable definition and was skipped`);
    return null;
  }
}
