// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each watch did, kept so a person can ask afterwards.
 *
 * A firing on its own is unreviewable. "This watch fired" tells an operator
 * nothing about whether it fired *for the right reason* — which node armed,
 * which key it armed under, what the judge was asked, what it declined. During
 * a shadow week the trace is most of the value: the whole point is to read what
 * the runtime would have done and decide whether it was right.
 *
 * Written by the host rather than the engine, which keeps the package producing
 * traces and the gateway deciding what to do with them. Bounded per watch,
 * because a trace is a debugging artefact and an unbounded one would quietly
 * become the largest thing in the install.
 */

import { addMissingColumns, SINGLETON_KEY, tableColumns } from "@omnesis/watch";
import type { EncryptedSqliteDatabase } from "../sqlite-encryption.js";
import type { ColumnAdditions, WatchTrace } from "@omnesis/watch";

/** Records kept per watch. Enough to read a week; small enough to forget. */
export const DEFAULT_RETAINED = 2_000;

/**
 * How many judge exchanges are kept per watch.
 *
 * Far below the trace retention, and deliberately: an exchange is a prompt and
 * a reply rather than a line, so a thousand of them is a different order of
 * disk. What it has to cover is a diagnosis — the last few days of a judge that
 * is deciding wrongly — and the daily cap means that is what this many is.
 */
export const EXCHANGES_RETAINED = 200;

/**
 * Days of judge spend kept.
 *
 * The cap only ever asks about today; a few days either side of it leave room
 * for a clock that moved backwards and give an operator reading a bill
 * something to read.
 */
export const JUDGE_SPEND_DAYS = 7;

/**
 * The columns this store's schema declares that a file already on disk will
 * not have, by table.
 *
 * Same discipline as the state store's: `CREATE TABLE IF NOT EXISTS` is read
 * only by a file that does not exist yet, so a column added to a shipped table
 * has to appear here too or the first query naming it fails — on the install
 * that booted yesterday, which is not the install any test boots.
 */
export const TRACE_COLUMN_ADDITIONS: Readonly<Record<string, ColumnAdditions>> = {
  watch_traces: { failure: "TEXT" },
  watch_judgements: { ever_matched: "INTEGER NOT NULL DEFAULT 0" },
};

/**
 * The transitions that are a node looking at something and taking nothing up.
 *
 * `ignored` covers both ways that happens — a colliding arm discarded because a
 * cell was already live, and a document no recall arm nominated. On a watch
 * with a narrow arm they are very nearly everything it sees: a real install had
 * all 2,000 retained records saying "no lexical term matched", which had
 * already evicted the one record explaining its one live cell.
 *
 * They are the runtime's noise floor, and the floor is worth *counting* — a
 * watch declining nearly everything it looks at is an arm too narrow to catch
 * what it was written for, and nothing else says so. It is not worth two
 * thousand copies of.
 */
const DECLINED_TRANSITIONS: ReadonlySet<string> = new Set(["ignored"]);

/**
 * How many declined records to keep per watch.
 *
 * A sample, not a history. Enough that a reader can see what a decline looks
 * like on this watch — the detail differs between "no lexical term matched" and
 * "an instance was already live" — and few enough that they cannot crowd out
 * the records that explain a firing.
 */
export const DECLINED_SAMPLE = 5;

/**
 * Bring a `watch_judgements` written before the instance key joined its
 * identity up to the current shape.
 *
 * The first version of the table was keyed on watch, node and subject. The key
 * had to join that identity, because a node judging accumulated evidence is
 * asked once per cell and two cells can lead with the same document — so
 * without it, one cell's decline overwrote another cell's match.
 *
 * The primary key is what forces a rebuild: `ALTER TABLE` can add a `NOT NULL`
 * column given a default, but it cannot widen a key. So the table is rebuilt
 * and its rows carried across under {@link SINGLETON_KEY}, which is the key
 * every unkeyed node is asked under and the only one an upgrade can guess — so
 * an old row and the next judgement about the same document converge on one row
 * rather than counting it twice, which is the whole point of the table.
 *
 * A node that judges accumulated evidence is asked under a cell key instead,
 * and which nodes those are is not knowable from this table: the shape lives in
 * the watch's definition, and a store of records does not read definitions.
 * Carrying such a row under `singleton` places it beside the rows that node
 * writes from then on. {@link WatchTraceStore.recordJudgement} settles that at
 * the moment the answer arrives — the first keyed write about a subject folds
 * the carried row into itself — which is the earliest point at which anything
 * here can know the node has a key at all.
 */
function widenJudgementsKey(db: EncryptedSqliteDatabase): void {
  const present = tableColumns(db, "watch_judgements");
  if (present.size === 0 || present.has("key")) return;
  // In one transaction, because the halves are not separately survivable.
  // `db.exec` autocommits per statement, so a crash after the rename and
  // before the create leaves a boot with *no* `watch_judgements` at all — and
  // the next one builds an empty one beside a stranded
  // `watch_judgements_unkeyed` nothing will ever read again. One transaction
  // makes the widening a fact or a non-event.
  db.exec(`
    BEGIN IMMEDIATE;
    -- Anything a previous attempt left behind. One transaction makes that
    -- unreachable now; a file written before this was transactional may still
    -- carry it, and the rename would fail on the name being taken — on every
    -- boot, forever.
    DROP TABLE IF EXISTS watch_judgements_unkeyed;
    ALTER TABLE watch_judgements RENAME TO watch_judgements_unkeyed;
    CREATE TABLE watch_judgements (
      watch_id     TEXT NOT NULL,
      node_id      TEXT NOT NULL,
      key          TEXT NOT NULL,
      subject      TEXT NOT NULL,
      decision     TEXT NOT NULL,
      at           TEXT NOT NULL,
      ever_matched INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (watch_id, node_id, key, subject)
    );
    INSERT INTO watch_judgements (watch_id, node_id, key, subject, decision, at, ever_matched)
      SELECT watch_id, node_id, '${SINGLETON_KEY}', subject, decision, at,
             -- Carried, not recomputed. The additive half has already run, so
             -- the old table has this column and it may hold a match the last
             -- answer no longer shows — which is the whole reason it exists.
             MAX(ever_matched, CASE WHEN decision = 'matched' THEN 1 ELSE 0 END)
        FROM watch_judgements_unkeyed;
    DROP TABLE watch_judgements_unkeyed;
    COMMIT;
  `);
}

export interface TraceRow {
  readonly watchId: string;
  readonly seq: number;
  readonly nodeId: string;
  readonly key: string;
  readonly transition: string;
  readonly detail: string | null;
  /**
   * Which kind of failure this was, on a `failed` record and nowhere else.
   *
   * Kept beside `detail` rather than folded into it because they answer
   * different questions and carry different risk: the class is a category the
   * runtime chose and is safe to print anywhere, where the detail is whatever a
   * backend said and may quote a value out of the corpus.
   */
  readonly failure: string | null;
  readonly at: string;
}

export class WatchTraceStore {
  constructor(
    private readonly db: EncryptedSqliteDatabase,
    private readonly retained: number = DEFAULT_RETAINED,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS watch_traces (
        rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id    TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        node_id     TEXT NOT NULL,
        key         TEXT NOT NULL,
        transition  TEXT NOT NULL,
        detail      TEXT,
        failure     TEXT,
        at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS watch_traces_watch ON watch_traces (watch_id, rowid_alias);
      /**
       * How many records of each class a watch has produced, ever.
       *
       * Durable across the roll-off, which is the point: the sample above is
       * bounded, so without this the page could say "5 declines" about a watch
       * that has declined four thousand times — a number that would be true of
       * the table and false about the watch.
       */
      CREATE TABLE IF NOT EXISTS watch_trace_class_counts (
        watch_id   TEXT NOT NULL,
        transition TEXT NOT NULL,
        seen       INTEGER NOT NULL,
        PRIMARY KEY (watch_id, transition)
      );
      /**
       * How the judge answered, per subject it was asked about, ever.
       *
       * Kept apart from the transition counts above because the transition
       * cannot say this. A judge's decline is written as a held record, and so
       * is every ordinary evaluation that did not fire, so that count is
       * dominated by nodes doing nothing in particular. The one question an
       * operator can act on -- does the judge ever say yes to this proposition
       * -- is not answerable from it.
       *
       * Durable, because the alternative is not. The judge's own tally lives
       * in the process, so a gateway restarted an hour ago reports nothing
       * about a watch that has been declining for a month.
       *
       * A row per thing judged rather than a running total, and that is the
       * whole point of the shape. The judge is asked outside the transaction
       * its event commits in, so a judgement is re-asked whenever the event
       * is: a node further down the same event throws, the transaction rolls
       * back, the watch pauses, and the resume re-reads it. A total would count
       * that document twice, and the sentence built on it claims *documents* --
       * so a watch stuck in a fail-and-resume loop could report ten nominated
       * having nominated one. Keyed on what was judged, re-asking converges
       * instead of accumulating.
       *
       * The instance key is part of that identity, not decoration. A node that
       * judges accumulated evidence is asked once per cell, and two cells can
       * lead with the same document -- so keying on the document alone would
       * let one cell's decline overwrite another cell's match -- and a judge
       * that has never matched is what both silence-reading verdicts gate on.
       * Erasing a match is the falsity this table exists to prevent.
       *
       * The decision column is the last answer, and the last answer wins: a
       * subject re-judged after new evidence arrived has genuinely been decided
       * again, and keeping the first would let a watch whose judge has since
       * said yes go on reading as one that never does.
       *
       * The ever_matched column is the answer that cannot be taken back, and it
       * exists because the other direction of that overwrite is a lie. A
       * document matched on one revision and declined on the next flips the
       * decision to declined, and with it the count both silence-reading
       * verdicts gate on: after ten such the operator is told the judge refused
       * every one, about a watch whose judge said yes. Set the first time a
       * subject matches and never cleared.
       *
       * So the two counts read off this table are about documents, not answers.
       * Matched is the documents the judge has ever admitted; declined is the
       * documents it has answered about and never admitted. They partition the
       * subjects, which is what a sentence claiming "its arm nominated N
       * documents" needs them to do.
       *
       * It grows with subjects judged rather than with time, bounded by the
       * judge's own daily budget -- a few hundred rows a day at the ceiling,
       * on an install where the judge runs at all.
       */
      CREATE TABLE IF NOT EXISTS watch_judgements (
        watch_id     TEXT NOT NULL,
        node_id      TEXT NOT NULL,
        key          TEXT NOT NULL,
        subject      TEXT NOT NULL,
        decision     TEXT NOT NULL,
        at           TEXT NOT NULL,
        ever_matched INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (watch_id, node_id, key, subject)
      );

      /**
       * What was actually said to the judge, and what came back.
       *
       * The row above keeps the verdict and, at most, a sentence the model
       * wrote about why. That is enough to count with and not enough to debug
       * with: a proposition that asks about the wrong field — the subject line
       * rather than the title — declines everything, correctly, and the
       * verdict alone reads as a quiet week. Reading the exchange is the
       * difference between a hypothesis and an experiment.
       *
       * Bounded twice over. The judge's own daily cap puts a ceiling of a few
       * hundred exchanges a day on an install where it runs at all, and the
       * newest {@link EXCHANGES_RETAINED} per watch are kept beyond that.
       *
       * Same privacy class as a compile transcript: the prompt quotes the
       * document, so this is on-host only and goes when the watch does.
       */
      CREATE TABLE IF NOT EXISTS watch_judge_exchanges (
        rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id    TEXT NOT NULL,
        node_id     TEXT NOT NULL,
        key         TEXT NOT NULL,
        subject     TEXT NOT NULL,
        -- matched, declined, or unreadable: what the reply came to, which is
        -- not always one of the two decisions the judgement row can hold.
        verdict     TEXT NOT NULL,
        prompt      TEXT NOT NULL,
        reply       TEXT NOT NULL,
        -- How long the provider took, which is the other thing a slow judge
        -- costs an operator and nothing else records per call.
        ms          INTEGER NOT NULL,
        at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS watch_judge_exchanges_watch
        ON watch_judge_exchanges (watch_id, rowid_alias);

      /**
       * How many judge calls each watch has made on each UTC day.
       *
       * The cap it feeds is a *daily* one, and a counter that lives only in
       * the judge object re-mints the whole allowance every time the gateway
       * restarts -- with the durable parked-nomination queue drained against
       * it seconds later, so the flooding case the cap exists for is exactly
       * the case where a day can be paid for several times over. The sibling
       * delivery and wake budgets keep their day counters on disk for the same
       * reason.
       *
       * A handful of rows a day, and only the recent days are kept: a cap only
       * ever asks about today.
       */
      CREATE TABLE IF NOT EXISTS watch_judge_spend (
        day      TEXT NOT NULL,
        watch_id TEXT NOT NULL,
        calls    INTEGER NOT NULL,
        PRIMARY KEY (day, watch_id)
      );
    `);
    // The running totals this replaces. Dropped rather than left in place: it
    // is read by nothing now, and a table of counts that no longer moves is
    // the kind of thing a later reader mistakes for the answer. The numbers in
    // it were the double-counted ones, so nothing worth keeping is lost -- a
    // watch's judge counts rebuild from its next judgement.
    db.exec("DROP TABLE IF EXISTS watch_judge_counts");
    // Additions first, then the rebuild. Two generations of this file are
    // missing the key and one of them already has `ever_matched`, so a rebuild
    // that ran first would have to guess which columns the old table has.
    // Running the additive half first makes the old table's shape known.
    for (const [table, additions] of Object.entries(TRACE_COLUMN_ADDITIONS)) {
      addMissingColumns(db, table, additions);
    }
    widenJudgementsKey(db);
    // Backfilled from the current decision, which is the closest thing an
    // upgraded file can say: a subject standing at `matched` has certainly
    // matched. A match already overwritten by a later decline is unrecoverable
    // — the row that recorded it is gone — and reads as never matched, the same
    // as it did before this column existed. Unconditional and idempotent: it
    // only ever sets a bit the writer would set anyway.
    db.exec("UPDATE watch_judgements SET ever_matched = 1 WHERE decision = 'matched'");
  }

  /**
   * Record one run's trace, then forget the oldest beyond the retention.
   *
   * One transaction: a half-written trace read alongside a firing it does not
   * explain is worse than no trace, because it reads as a complete account.
   */
  record(trace: WatchTrace, at: string): void {
    if (trace.records.length === 0) return;
    const insert = this.db.prepare<
      [string, number, string, string, string, string | null, string | null, string]
    >(
      `INSERT INTO watch_traces (watch_id, seq, node_id, key, transition, detail, failure, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const prune = this.db.prepare<[string, string, number]>(
      `DELETE FROM watch_traces
        WHERE watch_id = ?
          AND rowid_alias <= (
            SELECT rowid_alias FROM watch_traces WHERE watch_id = ?
             ORDER BY rowid_alias DESC LIMIT 1 OFFSET ?
          )`,
    );
    /**
     * Forget the declined records beyond the sample, before the general prune.
     *
     * Ordering matters: the general prune takes the oldest rows whatever they
     * are, so a burst of declines large enough to fill the retention would
     * carry a firing's records out with it. Capping the declines first means
     * the general prune only ever sees a handful of them, and everything it
     * evicts is a record that genuinely aged out.
     */
    const pruneDeclined = this.db.prepare<[string, string, number]>(
      `DELETE FROM watch_traces
        WHERE watch_id = ?
          AND transition IN (${[...DECLINED_TRANSITIONS].map(() => "?").join(",")})
          AND rowid_alias <= (
            SELECT rowid_alias FROM watch_traces
             WHERE watch_id = ?
               AND transition IN (${[...DECLINED_TRANSITIONS].map(() => "?").join(",")})
             ORDER BY rowid_alias DESC LIMIT 1 OFFSET ?
          )`,
    );
    const countClass = this.db.prepare<[string, string]>(
      `INSERT INTO watch_trace_class_counts (watch_id, transition, seen) VALUES (?, ?, 1)
       ON CONFLICT (watch_id, transition) DO UPDATE SET seen = seen + 1`,
    );
    const declinedArgs = [...DECLINED_TRANSITIONS];
    this.db.transaction(() => {
      for (const record of trace.records) {
        insert.run(
          trace.watch,
          record.seq,
          record.nodeId,
          record.key,
          record.transition,
          record.detail ?? null,
          record.failure ?? null,
          at,
        );
        // Counted whatever happens to the row afterwards. The count is what
        // survives the roll-off and it is the diagnostic; the rows are samples.
        countClass.run(trace.watch, record.transition);
      }
      pruneDeclined.run(
        ...([trace.watch, ...declinedArgs, trace.watch, ...declinedArgs, DECLINED_SAMPLE] as [
          string,
          string,
          number,
        ]),
      );
      prune.run(trace.watch, trace.watch, this.retained);
    })();
  }

  /**
   * Judge calls already charged to a UTC day, in total and per watch.
   *
   * Read once when the judge rolls onto a day, so a process that starts partway
   * through one continues that day's spend rather than starting it again.
   */
  judgeSpendOn(day: string): { total: number; byWatch: Record<string, number> } {
    const rows = this.db
      .prepare<
        [string],
        { watch_id: string; calls: number }
      >("SELECT watch_id, calls FROM watch_judge_spend WHERE day = ?")
      .all(day);
    const byWatch: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byWatch[row.watch_id] = row.calls;
      total += row.calls;
    }
    return { total, byWatch };
  }

  /**
   * Charge one judge call to a watch's day.
   *
   * Days older than the window nothing can ask about again go on the way in,
   * like every other bound in this store: a table trimmed by a sweep somewhere
   * else is a table that is unbounded between sweeps.
   */
  recordJudgeCall(watchId: string, day: string, retainedDays = JUDGE_SPEND_DAYS): void {
    const oldest = new Date(Date.parse(`${day}T00:00:00.000Z`) - retainedDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    this.db.transaction(() => {
      this.db
        .prepare<[string, string]>(
          `INSERT INTO watch_judge_spend (day, watch_id, calls) VALUES (?, ?, 1)
             ON CONFLICT (day, watch_id) DO UPDATE SET calls = calls + 1`,
        )
        .run(day, watchId);
      this.db.prepare<[string]>("DELETE FROM watch_judge_spend WHERE day < ?").run(oldest);
    })();
  }

  /**
   * Keep what was said to the judge about one subject, and what came back.
   *
   * Never allowed to fail the judgement. This is called from inside the
   * engine's evaluation, where anything thrown reads as the node failing and
   * pauses the watch — so a watch that judged correctly would be filed as
   * broken because a transcript could not be written.
   */
  recordJudgeExchange(entry: {
    watchId: string;
    nodeId: string;
    key: string;
    subject: string;
    verdict: string;
    prompt: string;
    reply: string;
    ms: number;
    at: string;
  }): void {
    const write = this.db.prepare<
      [string, string, string, string, string, string, string, number, string]
    >(
      `INSERT INTO watch_judge_exchanges
         (watch_id, node_id, key, subject, verdict, prompt, reply, ms, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Pruned per watch on the way in, like the trace records: a bound enforced
    // by a sweep somewhere else is a bound that is wrong between sweeps.
    const prune = this.db.prepare<[string, string, number]>(
      `DELETE FROM watch_judge_exchanges
        WHERE watch_id = ?
          AND rowid_alias <= (
            SELECT rowid_alias FROM watch_judge_exchanges WHERE watch_id = ?
             ORDER BY rowid_alias DESC LIMIT 1 OFFSET ?
          )`,
    );
    this.db.transaction(() => {
      write.run(
        entry.watchId,
        entry.nodeId,
        entry.key,
        entry.subject,
        entry.verdict,
        entry.prompt,
        entry.reply,
        entry.ms,
        entry.at,
      );
      prune.run(entry.watchId, entry.watchId, EXCHANGES_RETAINED);
    })();
  }

  /**
   * The exchanges kept for a watch, newest first.
   *
   * Newest first because the question this answers is "what is it doing now" —
   * a judge that started deciding wrongly did so at one end of this list, and
   * it is not the old one.
   */
  judgeExchanges(
    watchId: string,
    limit = 20,
  ): {
    nodeId: string;
    key: string;
    subject: string;
    verdict: string;
    prompt: string;
    reply: string;
    ms: number;
    at: string;
  }[] {
    return this.db
      .prepare<
        [string, number],
        {
          node_id: string;
          key: string;
          subject: string;
          verdict: string;
          prompt: string;
          reply: string;
          ms: number;
          at: string;
        }
      >(
        `SELECT node_id, key, subject, verdict, prompt, reply, ms, at
           FROM watch_judge_exchanges WHERE watch_id = ?
          ORDER BY rowid_alias DESC LIMIT ?`,
      )
      .all(watchId, limit)
      .map((row) => ({
        nodeId: row.node_id,
        key: row.key,
        subject: row.subject,
        verdict: row.verdict,
        prompt: row.prompt,
        reply: row.reply,
        ms: row.ms,
        at: row.at,
      }));
  }

  /**
   * Record what the judge decided about one subject.
   *
   * `matched` and `declined` are the judge's own two answers. A judgement that
   * did not happen — over budget, provider unreachable — is neither and is not
   * recorded here: it says something about the install, not about whether this
   * watch's proposition is ever true.
   *
   * The subject is the document the judge was shown, or the instance key where
   * a node judges accumulated evidence rather than a document. Either way it
   * names the thing decided about, so asking again about it — which the engine
   * does whenever an event is re-evaluated — settles on one row.
   */
  recordJudgement(entry: {
    watchId: string;
    nodeId: string;
    /** The instance the judge was asked for — two cells can lead with one document. */
    key: string;
    subject: string;
    decision: "matched" | "declined";
    at: string;
  }): void {
    // A keyed write says the node has an instance key, so a row it holds for
    // this subject under `singleton` is one nothing will write again — left by
    // the rebuild that carried a pre-key table across, or by an earlier shape
    // of a node whose id a recompile reused. Either way it names the same
    // judgement under a key that is no longer asked for, and left alone it is
    // counted a second time forever. Folded here, where the two rows are
    // provably about one subject, with its sticky match carried onto the row
    // that replaces it — dropped instead, a document the judge admitted would
    // read as one it never did.
    //
    // Skipped on a singleton write, which would otherwise delete the row it is
    // about to write and reinsert it for the same result.
    const fold = this.db.prepare<[string, string, string, string], { ever_matched: number }>(
      `DELETE FROM watch_judgements
        WHERE watch_id = ? AND node_id = ? AND key = ? AND subject = ?
        RETURNING ever_matched`,
    );
    const write = this.db.prepare<[string, string, string, string, string, string, number]>(
      `INSERT INTO watch_judgements (watch_id, node_id, key, subject, decision, at, ever_matched)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (watch_id, node_id, key, subject)
         DO UPDATE SET decision = excluded.decision,
                       at = excluded.at,
                       -- Never back to 0. The last answer is what the judge
                       -- thinks now; whether it has ever said yes about this
                       -- document is a different fact, and one a later
                       -- decline does not undo.
                       ever_matched = MAX(watch_judgements.ever_matched, excluded.ever_matched)`,
    );
    // One transaction, because the fold destroys a judgement in order to move
    // it: between the delete and the insert the subject has been decided about
    // and this store says nothing of it.
    this.db.transaction(() => {
      // Known bug: #1933 — a node with one keyed edge and one unkeyed edge writes
      // both key shapes from two live instances, and this reads the singleton one
      // as a leftover. No watch has that shape today.
      const carried =
        entry.key === SINGLETON_KEY
          ? undefined
          : fold.get(entry.watchId, entry.nodeId, SINGLETON_KEY, entry.subject);
      write.run(
        entry.watchId,
        entry.nodeId,
        entry.key,
        entry.subject,
        entry.decision,
        entry.at,
        Math.max(entry.decision === "matched" ? 1 : 0, carried?.ever_matched ?? 0),
      );
    })();
  }

  /**
   * What the judge has decided for every watch, counted in **documents**.
   *
   * `matched` is the subjects it has ever admitted; `declined` is the subjects
   * it has answered about and never admitted. The two partition what was
   * judged, which is what a sentence claiming "its arm nominated N documents"
   * needs — and it is why a subject the judge admitted once and refused later
   * counts as matched rather than moving across. A document that has ever
   * matched is not one the judge refused, and saying so is the falsity this
   * table exists to prevent.
   */
  judgementsAll(): Map<string, { matched: number; declined: number }> {
    const rows = this.db
      .prepare<[], { watch_id: string; matched: number; declined: number }>(
        `SELECT watch_id,
                SUM(ever_matched) AS matched,
                SUM(CASE WHEN ever_matched = 0 THEN 1 ELSE 0 END) AS declined
           FROM watch_judgements GROUP BY watch_id`,
      )
      .all();
    return new Map(
      rows.map((row) => [row.watch_id, { matched: row.matched, declined: row.declined }]),
    );
  }

  /** Every watch's class counts, for a surface that reports on all of them. */
  classCountsAll(): Map<string, Record<string, number>> {
    const rows = this.db
      .prepare<
        [],
        { watch_id: string; transition: string; seen: number }
      >(`SELECT watch_id, transition, seen FROM watch_trace_class_counts`)
      .all();
    const out = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const entry = out.get(row.watch_id) ?? {};
      entry[row.transition] = row.seen;
      out.set(row.watch_id, entry);
    }
    return out;
  }

  /**
   * How many records of each class this watch has produced, ever — **at least**.
   *
   * The counts outlive the rows, so a surface can say "looked at 4,183, matched
   * none, 5 samples kept" rather than reporting the size of a bounded sample as
   * if it were a history.
   *
   * They are a floor rather than an exact tally, and deliberately so: a counter
   * is incremented in the same transaction that writes the record it counts, so
   * an evaluation whose cursor advanced before the process died is a decision
   * that happened and was never counted. Undercounting is the honest direction —
   * a floor that says "at least this many" can only understate how busy a watch
   * has been, where a count reconstructed after the fact could claim decisions
   * nobody can produce a record for.
   */
  classCounts(watchId: string): Record<string, number> {
    const rows = this.db
      .prepare<
        [string],
        { transition: string; seen: number }
      >(`SELECT transition, seen FROM watch_trace_class_counts WHERE watch_id = ?`)
      .all(watchId);
    return Object.fromEntries(rows.map((row) => [row.transition, row.seen]));
  }

  /** The most recent records for a watch, oldest first. */
  recent(watchId: string, limit = 200): TraceRow[] {
    const rows = this.db
      .prepare<
        [string, number],
        {
          watch_id: string;
          seq: number;
          node_id: string;
          key: string;
          transition: string;
          detail: string | null;
          failure: string | null;
          at: string;
        }
      >(
        `SELECT watch_id, seq, node_id, key, transition, detail, failure, at FROM watch_traces
          WHERE watch_id = ? ORDER BY rowid_alias DESC LIMIT ?`,
      )
      .all(watchId, limit);
    return rows
      .map((row) => ({
        watchId: row.watch_id,
        seq: row.seq,
        nodeId: row.node_id,
        key: row.key,
        transition: row.transition,
        detail: row.detail,
        failure: row.failure,
        at: row.at,
      }))
      .reverse();
  }

  /**
   * Erase a watch's account of itself.
   *
   * The other half of what removing a watch means. The runtime's own state
   * lives in a table this store cannot see and is cleared beside it; without
   * this, a week of add-tune-remove leaves up to the retention bound of orphan
   * records per removed watch, and the prune never reclaims them because it is
   * keyed on the watch that no longer exists.
   */
  forget(watchId: string): void {
    this.db.prepare<[string]>("DELETE FROM watch_traces WHERE watch_id = ?").run(watchId);
    // The counters go with them. They outlive the rows on purpose, but not the
    // watch: a re-added watch of the same id would otherwise open with somebody
    // else's history of declines.
    this.db.prepare<[string]>("DELETE FROM watch_judgements WHERE watch_id = ?").run(watchId);
    // The exchanges quote the corpus, so they go with the watch rather than
    // ageing out of a table nobody is reading any more.
    this.db.prepare<[string]>("DELETE FROM watch_judge_exchanges WHERE watch_id = ?").run(watchId);
    this.db
      .prepare<[string]>("DELETE FROM watch_trace_class_counts WHERE watch_id = ?")
      .run(watchId);
  }

  /** How many records are held for a watch — the shadow report reads this. */
  count(watchId: string): number {
    return (
      this.db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM watch_traces WHERE watch_id = ?")
        .get(watchId)?.n ?? 0
    );
  }
}
