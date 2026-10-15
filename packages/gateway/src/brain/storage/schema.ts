// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * DDL for the Briefs / Cognition Steward tables. Idempotent (`CREATE TABLE IF
 * NOT EXISTS` throughout) — invoked from `runSchemaSetup` on every boot
 * AND from the numbered migration that introduced the tables, so both a
 * fresh install and an upgrading one converge on the same shape from a
 * single source of DDL truth.
 *
 * Array-valued loop/observation fields (actors, involved, docs, blocked_by,
 * citations, related_loop_ids) that a cascade, the deletion invariant, or
 * a by-value reconcile scan must look up BY VALUE live in join tables
 * (`open_loop_docs`, `open_loop_people`, `observation_citations`,
 * `observation_related_loops`) so those scans are indexed. Arrays nothing
 * queries by value stay JSON columns.
 */

import { createRunAttributionTable } from "./run-attribution.js";
import { createCognitionCoverageTable } from "./coverage.js";
import { createSweepTallyTable } from "./sweep-tally.js";
import { createCognitionDecisionsTable } from "./decisions.js";
import type Database from "better-sqlite3";
type Db = Database.Database;

export function createBriefsStorageTables(db: Db): void {
  // The authoritative open-loop store. A searchable projection of each
  // row is mirrored into `documents` (type `open-loop`) by the open-loop
  // system source; that mirror is derived state, never the truth.
  db.exec(`
    CREATE TABLE IF NOT EXISTS open_loops (
      id TEXT PRIMARY KEY,
      created_by_run TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      confidence REAL NOT NULL,
      importance REAL NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      deadline_json TEXT,
      actors_json TEXT NOT NULL DEFAULT '[]',
      involved_json TEXT NOT NULL DEFAULT '[]',
      blocked_by_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      last_update INTEGER NOT NULL,
      last_decay_check INTEGER,
      decay_check_count INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'brain',
      accepted INTEGER NOT NULL DEFAULT 0,
      ignored INTEGER NOT NULL DEFAULT 0,
      scheduled_for TEXT,
      proposed_change_json TEXT,
      completion_note TEXT,
      resolved_at INTEGER
    )
  `);
  // Decay-engine scan: stale loops by state + last_update.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_open_loops_state_update ON open_loops(state, last_update DESC, id DESC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_open_loops_update_page ON open_loops(last_update DESC, id DESC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_open_loops_importance_page ON open_loops(importance DESC, last_update DESC, id DESC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_open_loops_state_importance_page ON open_loops(state, importance DESC, last_update DESC, id DESC)",
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_open_loops_active_importance_page
      ON open_loops(importance DESC, last_update DESC, id DESC)
      WHERE state IN ('open', 'snoozed');
    CREATE INDEX IF NOT EXISTS idx_open_loops_resolved_importance_page
      ON open_loops(importance DESC, last_update DESC, id DESC)
      WHERE state IN ('done', 'dismissed');
    CREATE INDEX IF NOT EXISTS idx_open_loops_active_update_page
      ON open_loops(last_update DESC, id DESC)
      WHERE state IN ('open', 'snoozed');
    CREATE INDEX IF NOT EXISTS idx_open_loops_resolved_update_page
      ON open_loops(last_update DESC, id DESC)
      WHERE state IN ('done', 'dismissed');
  `);

  // docs[] normalized for the privacy-delete cascade: "which loops cite
  // this document" must be an indexed lookup, not a JSON scan. No FK to
  // documents(id) — the cascade is invoked explicitly from the privacy
  // -delete path only, never implied by other document-delete paths
  // (source wipes, re-syncs).
  db.exec(`
    CREATE TABLE IF NOT EXISTS open_loop_docs (
      loop_id TEXT NOT NULL REFERENCES open_loops(id) ON DELETE CASCADE,
      doc_id TEXT NOT NULL,
      PRIMARY KEY (loop_id, doc_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_open_loop_docs_doc ON open_loop_docs(doc_id)");

  // actors[]/involved[] normalized so loops are reconcilable BY the
  // real-world people on them: the identity-based reconcile scan
  // (`searchOpenLoopsByIdentity`) joins a datum's `document_people` to this
  // table to find loops that share an actor/involved person. `role` keeps
  // the two lists distinguishable (`'actor'` / `'involved'`); a person on
  // both roles of one loop yields two rows. No FK to `people(id)` — people
  // rows merge and re-derive out from under a loop, so the join tolerates a
  // stale id (an over-match the agent inspects), exactly like the deliberate
  // no-FK on `open_loop_docs.doc_id`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS open_loop_people (
      loop_id TEXT NOT NULL REFERENCES open_loops(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (loop_id, person_id, role)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_open_loop_people_person ON open_loop_people(person_id)");

  // agent_ledger[]: timestamped notes, oldest → newest, each stamped with
  // the run that appended it. AUTOINCREMENT gives a stable append order
  // even when two entries share a millisecond.
  db.exec(`
    CREATE TABLE IF NOT EXISTS open_loop_ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      loop_id TEXT NOT NULL REFERENCES open_loops(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      note TEXT NOT NULL,
      event_json TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_open_loop_ledger_loop ON open_loop_ledger(loop_id, seq)");
  createTaskIndexes(db);

  // Observations: private notes any agent run makes for the next morning
  // brief. The morning run ships, holds or drops each one.
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      created_by_run TEXT NOT NULL,
      summary TEXT NOT NULL,
      why TEXT NOT NULL DEFAULT '',
      user_authored INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER,
      relevant_until INTEGER,
      claims_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'live'
        CHECK(state IN ('live','held','shipped','dropped')),
      close_reason TEXT,
      noted_scores_json TEXT,
      scores_json TEXT,
      would_push_at INTEGER,
      shipped_at INTEGER,
      shipped_conversation_id TEXT,
      shipped_message_id TEXT,
      user_action TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_observations_open
      ON observations(created_at, id) WHERE state IN ('live','held');
    CREATE INDEX IF NOT EXISTS idx_observations_created_page
      ON observations(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_observations_closed
      ON observations(closed_at) WHERE closed_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_observations_would_push
      ON observations(would_push_at) WHERE would_push_at IS NOT NULL;
  `);
  // citations[] normalized for the privacy-delete cascade (indexed
  // "which observations cite this document"). `position` keeps cited order.
  db.exec(`
    CREATE TABLE IF NOT EXISTS observation_citations (
      observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      doc_id TEXT NOT NULL,
      PRIMARY KEY (observation_id, position)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_observation_citations_doc ON observation_citations(doc_id)",
  );
  // Deliberately no FK to open_loops: deleting a loop deletes its open
  // observations through `deleteOpenLoop`, which an edge cascade would not.
  db.exec(`
    CREATE TABLE IF NOT EXISTS observation_related_loops (
      observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      loop_id TEXT NOT NULL,
      PRIMARY KEY (observation_id, loop_id)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_observation_related_loops_loop ON observation_related_loops(loop_id)",
  );
  // The ranked observations chosen for one morning's brief, written by the
  // morning recheck and stamped with the conversation message that carried
  // them. Replies that refer to "the second item" resolve through this list.
  db.exec(`
    CREATE TABLE IF NOT EXISTS morning_brief_items (
      day TEXT NOT NULL,
      rank INTEGER NOT NULL,
      observation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      conversation_id TEXT,
      message_id TEXT,
      PRIMARY KEY (day, rank)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_morning_brief_items_message ON morning_brief_items(message_id)",
  );
  // One row per sent morning brief: at most one message a day.
  db.exec(`
    CREATE TABLE IF NOT EXISTS morning_briefs (
      day TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      sent_at INTEGER NOT NULL
    )
  `);
  // What remains of a closed observation once its retention window passes:
  // enough to calibrate the decision bar and review the "would have pushed"
  // log, without the cited text or evidence links.
  db.exec(`
    CREATE TABLE IF NOT EXISTS observation_outcomes (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      source_kinds_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL,
      close_reason TEXT,
      noted_scores_json TEXT,
      scores_json TEXT,
      would_push_at INTEGER,
      user_action TEXT,
      created_at INTEGER NOT NULL,
      closed_at INTEGER,
      pruned_at INTEGER NOT NULL
    )
  `);

  // The Agent Run Queue — a durable outbox:
  // in-flight rows stay `pending` with bumped attempts; a crash mid-run
  // is naturally re-claimed once next_attempt_at is due.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      failure_code TEXT,
      next_attempt_at INTEGER NOT NULL,
      enqueued_at INTEGER NOT NULL,
      cycle_anchor_at INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      completed_at INTEGER,
      usage_json TEXT
    )
  `);
  // Only the three most recent synthesis admissions are retained; no corpus IDs.
  db.exec(`CREATE TABLE IF NOT EXISTS cognition_synthesis_admissions (
    sequence INTEGER PRIMARY KEY,
    joint_work INTEGER NOT NULL,
    policy_repair INTEGER NOT NULL
  )`);
  // `cycle_anchor_at` is the MUTABLE per-cycle anchor for the max-defer
  // ceiling: a continuously-folded `data` run's `next_attempt_at` is
  // clamped to `cycle_anchor_at + maxDefer`, so a forever-hot conversation/
  // document still becomes claimable within a bounded time. Set to `now` on
  // INSERT and reset to `now` on an in-flight-fold resurrect (a fresh
  // cycle); left untouched by a fold. The `DEFAULT 0` mirrors migration 35's
  // ALTER so a fresh CREATE and an upgraded table converge on one shape —
  // inert in practice because every INSERT sets the column explicitly.
  // Primary claim path: WHERE status='pending' AND next_attempt_at <= now.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cognition_runs_due ON cognition_runs(status, next_attempt_at ASC, id ASC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cognition_runs_enqueued_page ON cognition_runs(enqueued_at DESC, id DESC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cognition_runs_scheduled_page ON cognition_runs(next_attempt_at ASC, id ASC)",
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cognition_runs_synthesis_fairness
      ON cognition_runs(last_attempt_at DESC,
        CASE WHEN json_extract(payload_json,'$.focus')='knowledge-maintenance'
          AND json_extract(payload_json,'$.schedulingClass')='initial-root' THEN 1 ELSE 0 END DESC,
        id DESC)
      WHERE kind='synthesis' AND last_attempt_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_cognition_runs_status_enqueued_page
      ON cognition_runs(status, enqueued_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_cognition_runs_kind_enqueued_page
      ON cognition_runs(kind, enqueued_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_cognition_runs_status_kind_enqueued_page
      ON cognition_runs(status, kind, enqueued_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_cognition_runs_kind_scheduled_page
      ON cognition_runs(kind, next_attempt_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_cognition_runs_status_kind_scheduled_page
      ON cognition_runs(status, kind, next_attempt_at ASC, id ASC);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cognition_runs_retention
      ON cognition_runs(completed_at, id)
      WHERE status IN ('completed', 'failed') AND completed_at IS NOT NULL
  `);
  // Fold-on-update: at most one PENDING row per dedupe key (a later
  // update to the same document folds into the existing row). Completed
  // and failed rows keep their key for audit without blocking new runs.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cognition_runs_pending_dedupe
      ON cognition_runs(dedupe_key)
      WHERE status = 'pending' AND dedupe_key IS NOT NULL
  `);

  // Durable per-run attribution — which workflow, at which contract version,
  // on which model. Outlives the run rows (those are pruned) so an artifact's
  // `created_by_run` stays answerable. See `storage/run-attribution.ts`.
  createRunAttributionTable(db);

  // Per-(source, workflow, workflow version) coverage tallies — how much of
  // each source's corpus has been reasoned over, and at what cost. Reporting
  // only: nothing on the selection path reads it. See `storage/coverage.ts`.
  createCognitionCoverageTable(db);
  createCognitionDecisionsTable(db);

  // Per-sweep production tallies — durable because run rows are pruned and
  // `cognition_spend` has no per-sweep dimension. See `storage/sweep-tally.ts`.
  createSweepTallyTable(db);

  // Per-(day, mechanism, model) token totals for the cognitive
  // mechanisms (tracking only, no caps). Survives run-row pruning — this
  // is the durable accounting record. `mechanism` names the semantic
  // procedure that spent the tokens: a cognitive workflow id for background
  // work (`datum-intake`, `daily-source-review`, `noticing`, …; see
  // `brain/cognition/workflows.ts`), a `deep-research:<specialist>` stage,
  // `interactive` / `subagent`, or an evaluator (`entailment-gate`,
  // `observation-salience`). The table is append-only and survives run-row pruning, so
  // an id is never renamed in place — that would split one workload's history
  // across two buckets. `model_id` is the resolved backend's model id ('' when
  // unknown). The cache columns are
  // subsets of prompt_tokens (which stays the input-side total): reads
  // were served from the provider's prompt cache at the discounted rate,
  // creations were written to it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_spend (
      day TEXT NOT NULL,
      mechanism TEXT NOT NULL,
      model_id TEXT NOT NULL DEFAULT '',
      runs INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, mechanism, model_id)
    )
  `);

  // The pre-mechanism-split day-total spend table. No longer written —
  // `cognition_spend` is its successor (migration 54 copied these rows in
  // as mechanism 'unattributed') — but kept, data intact, so a downgraded
  // binary that still reads it finds its history rather than a missing
  // table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_spend_daily (
      day TEXT PRIMARY KEY,
      runs INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0
    )
  `);

  // The agent-curated notes blob: a single size-capped row injected into
  // every run's prompt. CHECK pins the singleton.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_notes (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    )
  `);

  // Background-engine bookkeeping (daily last-run day marker, decay
  // dirty-mark versions) — one row per key. See storage/engine-state.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_engine_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // The consolidation store: an append-only trace of every loop that was
  // resolved (`done`/`dismissed`) or removed via the write-gated delete
  // (`decayed`/`deleted`). Reconcile surfaces lexical matches from it so a
  // recurring commitment is recognised as a known recurrence. `title_norm`
  // is the recurrence key (see storage/retired-loops.ts); `cadence_days` and
  // `recurrence_count` are derived from the prior trace sharing that key. A
  // privacy delete NEVER writes here — it purges derived content, so a
  // lingering trace would leak it (enforced in cascadeOpenLoopPrivacyDelete).
  db.exec(`
    CREATE TABLE IF NOT EXISTS retired_loops (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_norm TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      actors_json TEXT NOT NULL DEFAULT '[]',
      involved_json TEXT NOT NULL DEFAULT '[]',
      outcome TEXT NOT NULL,
      importance REAL NOT NULL,
      deadline_json TEXT,
      created_at INTEGER NOT NULL,
      retired_at INTEGER NOT NULL,
      cadence_days INTEGER,
      recurrence_count INTEGER NOT NULL DEFAULT 1
    )
  `);
  // Recurrence lookup: most-recent prior retirement sharing a normalized title.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_retired_loops_title_norm ON retired_loops(title_norm, retired_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_retired_loops_page ON retired_loops(retired_at DESC, id DESC)",
  );
}

/**
 * Indexes the Tasks views read through: the user's own loops by schedule,
 * and Brain suggestions awaiting a decision. Guarded on the columns, which an
 * older database gains in migration 198 after this setup pass.
 */
export function createTaskIndexes(db: Db): void {
  const columns = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('open_loops')")
    .all()
    .map((c) => c.name);
  if (!columns.includes("scheduled_for")) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_open_loops_owned_schedule
      ON open_loops(scheduled_for, last_update DESC)
      WHERE origin != 'brain' OR accepted = 1;
    CREATE INDEX IF NOT EXISTS idx_open_loops_suggested
      ON open_loops(last_update DESC, id DESC)
      WHERE origin = 'brain' AND accepted = 0 AND state = 'open';
  `);
}
