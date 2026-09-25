// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * DDL for the Briefs / Cognition Steward tables. Idempotent (`CREATE TABLE IF
 * NOT EXISTS` throughout) — invoked from `runSchemaSetup` on every boot
 * AND from the numbered migration that introduced the tables, so both a
 * fresh install and an upgrading one converge on the same shape from a
 * single source of DDL truth.
 *
 * Array-valued loop/brief fields (actors, involved, docs, blocked_by,
 * citations, related_loop_ids) that a cascade, the deletion invariant, or
 * a by-value reconcile scan must look up BY VALUE live in join tables
 * (`open_loop_docs`, `open_loop_people`, `brief_citations`,
 * `brief_related_loops`) so those scans are indexed. Arrays nothing
 * queries by value stay JSON columns.
 */

import { createRunAttributionTable } from "./run-attribution.js";
import { createCognitionCoverageTable } from "./coverage.js";
import { createSweepTallyTable } from "./sweep-tally.js";
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
      decay_check_count INTEGER NOT NULL DEFAULT 0
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
      note TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_open_loop_ledger_loop ON open_loop_ledger(loop_id, seq)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS briefs (
      id TEXT PRIMARY KEY,
      created_by_run TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      body TEXT,
      confidence REAL NOT NULL,
      urgency REAL NOT NULL,
      relevant_until INTEGER,
      next_show INTEGER,
      event_at INTEGER,
      user_feedback TEXT,
      state TEXT NOT NULL DEFAULT 'unread',
      read_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      thread_conversation_id TEXT
    )
  `);
  // Feed selection: `state IN ('unread','read') AND next_show ≤ now`.
  db.exec("CREATE INDEX IF NOT EXISTS idx_briefs_state_next_show ON briefs(state, next_show)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_briefs_created_page ON briefs(created_at DESC, id DESC)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_briefs_state_created_page ON briefs(state, created_at DESC, id DESC)",
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_briefs_active_created_page
      ON briefs(created_at DESC, id DESC)
      WHERE state IN ('unread', 'read');
    CREATE INDEX IF NOT EXISTS idx_briefs_dismissed_created_page
      ON briefs(created_at DESC, id DESC)
      WHERE state IN (
        'dismissed_already_handled',
        'dismissed_acknowledged',
        'dismissed_not_relevant',
        'dismissed_wrong'
      );
  `);
  const briefColumns = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('briefs')")
    .all()
    .map((row) => row.name);
  // Existing databases gain read_at in the numbered migration, which runs
  // after this idempotent schema setup pass.
  if (briefColumns.includes("read_at")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_briefs_read_snapshot ON briefs(read_at DESC)");
  }

  // citations[] normalized for the privacy-delete cascade (indexed
  // "which briefs cite this document"). `position` preserves display order.
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_citations (
      brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      doc_id TEXT NOT NULL,
      PRIMARY KEY (brief_id, position)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_brief_citations_doc ON brief_citations(doc_id)");

  // related_loop_ids[] normalized for the deletion invariant (deleting a
  // loop deletes its attached non-terminal briefs). Deliberately no FK
  // to open_loops — a bare FK cascade would drop only the EDGE and leave
  // the brief orphaned; `deleteOpenLoop` enforces the real invariant.
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_related_loops (
      brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
      loop_id TEXT NOT NULL,
      PRIMARY KEY (brief_id, loop_id)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_brief_related_loops_loop ON brief_related_loops(loop_id)",
  );

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
  // `brief-judge`). The table is append-only and survives run-row pruning, so
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
