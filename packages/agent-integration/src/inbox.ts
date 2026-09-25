// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import {
  answerCompletionDeliveryHash,
  deliveryPayloadHash,
  answerCompletionDeliverySchema,
  deliveryOutcomeAuthority,
  subscriptionDeliverySchema,
  type AnswerCompletionDelivery,
  type DeliveryAcceptance,
  type DeliveryCancellation,
  type DeliveryPreparation,
  type SubscriptionDelivery,
} from "./protocol.js";

type Db = DatabaseSync;

export type InboxState = "prepared" | "starting" | "accepted" | "cancelled";

export interface WorkflowBinding {
  workflowHandle: string;
  nativeSessionId: string;
  nativeFlowId: string | null;
  updatedAt: number;
}

export interface NativeRunIdentity {
  localRunId: string;
  nativeSessionId: string;
  nativeFlowId?: string | null;
}

export interface FiringAuthority {
  deliveryId: string;
  firingId: string;
  nativeSessionId: string;
  endpoint: string;
  token: string;
  expiresAt: number;
}

export interface OutcomeAuthority {
  deliveryId: string;
  firingId: string;
  nativeSessionId: string;
  endpoint: string;
  token: string;
  expiresAt: number;
  /** The run is waiting on a held answer that will re-enter it later. */
  deferred: boolean;
}

export interface DeliveryStartContext {
  delivery: SubscriptionDelivery;
  binding: WorkflowBinding | null;
}

type DeliveryStartClaim =
  | { kind: "start"; delivery: SubscriptionDelivery }
  | { kind: "accepted"; acceptance: DeliveryAcceptance };

type AnswerCompletionStartClaim =
  | { kind: "start"; delivery: AnswerCompletionDelivery }
  | { kind: "accepted"; acceptance: DeliveryAcceptance };

export type DeliveryStarter = (
  context: DeliveryStartContext,
) => Promise<NativeRunIdentity> | NativeRunIdentity;

export type AnswerCompletionStarter = (delivery: AnswerCompletionDelivery) => Promise<void> | void;

interface InboxRow {
  delivery_id: string;
  payload_hash: string;
  payload_json: string;
  state: InboxState;
  accepted_at: number | null;
  local_run_id: string | null;
  last_error: string | null;
  updated_at: number;
}

interface BindingRow {
  workflow_handle: string;
  native_session_id: string;
  native_flow_id: string | null;
  updated_at: number;
}

type AnswerCompletionInboxRow = InboxRow & { start_attempts: number };

/**
 * How many times an answer may be posted at a harness that never confirmed.
 *
 * A run start parks on the first ambiguity and stays parked: starting an agent
 * twice runs its side effects twice, and no answer to "did it start?" is worth
 * that. Posting an answer is not the same trade. The worst case is the operator
 * reading it twice; the worst case of parking is that they asked a question,
 * the harness swallowed the reply, and nothing ever says so — which is the
 * failure they cannot even see to complain about.
 *
 * Three, because the gateway backs off exponentially between attempts, so this
 * spans minutes rather than milliseconds: an in-flight post has time to finish
 * and mark itself accepted before the next one is allowed.
 */
const ANSWER_COMPLETION_START_ATTEMPTS = 3;

export class DeliveryConflictError extends Error {
  constructor(deliveryId: string) {
    super(`delivery ${deliveryId} was replayed with a different payload`);
    this.name = "DeliveryConflictError";
  }
}

export class WorkflowBindingConflictError extends Error {
  constructor(workflowHandle: string) {
    super(`native execution identity changed for workflow ${workflowHandle}`);
    this.name = "WorkflowBindingConflictError";
  }
}

export class AmbiguousDeliveryError extends Error {
  constructor(deliveryId: string) {
    super(
      `delivery ${deliveryId} may already have started in the native harness and cannot be replayed safely`,
    );
    this.name = "AmbiguousDeliveryError";
  }
}

export class DeliveryNotPreparedError extends Error {
  constructor(deliveryId: string) {
    super(`delivery ${deliveryId} has not been prepared`);
    this.name = "DeliveryNotPreparedError";
  }
}

export class DeliveryCancelledError extends Error {
  constructor(deliveryId: string) {
    super(`delivery ${deliveryId} was cancelled before commit`);
    this.name = "DeliveryCancelledError";
  }
}

export class DeliveryAuthorityExpiredError extends Error {
  constructor(deliveryId: string) {
    super(`delivery ${deliveryId} has an expired firing answer authority`);
    this.name = "DeliveryAuthorityExpiredError";
  }
}

interface DurableIntegrationInboxHooks {
  /** Test-only contention seam immediately before the durable start claim. */
  beforeStartClaim?: () => void;
  /** Test-only crash seam after native acceptance and before the durable ACK commit. */
  beforeAcceptanceCommit?: () => void;
}

const sqliteInitializationWait = new Int32Array(new SharedArrayBuffer(4));

function configureJournalMode(db: Db): void {
  const deadline = performance.now() + 30_000;
  let retryDelay = 5;
  for (;;) {
    try {
      const current = getRow<{ journal_mode: string }>(db.prepare("PRAGMA journal_mode"));
      if (current?.journal_mode.toLowerCase() === "wal") return;
      const configured = getRow<{ journal_mode: string }>(db.prepare("PRAGMA journal_mode = WAL"));
      if (configured?.journal_mode.toLowerCase() !== "wal") {
        throw new Error(
          `failed to configure the integration inbox for WAL journaling: ${
            configured?.journal_mode ?? "no result"
          }`,
        );
      }
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("errcode" in error) ||
        typeof error.errcode !== "number" ||
        (error.errcode & 0xff) !== 5 ||
        performance.now() >= deadline
      ) {
        throw error;
      }
      Atomics.wait(sqliteInitializationWait, 0, 0, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 100);
    }
  }
}

function openPrivateDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 5_000 });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") configureJournalMode(db);
    db.exec(`
    CREATE TABLE IF NOT EXISTS integration_inbox (
      delivery_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','starting','accepted','cancelled')),
      accepted_at INTEGER,
      local_run_id TEXT,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_integration_inbox_recover
      ON integration_inbox(state, updated_at);

    CREATE TABLE IF NOT EXISTS integration_delivery_cancellations (
      delivery_id TEXT PRIMARY KEY,
      cancelled_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_answer_completion_inbox (
      delivery_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','starting','accepted','cancelled')),
      accepted_at INTEGER,
      local_run_id TEXT,
      last_error TEXT,
      updated_at INTEGER NOT NULL,
      -- How many times posting this answer has been attempted. A run start
      -- parks forever on the first ambiguity; an answer is allowed a few more
      -- tries, and this is what bounds them.
      start_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_integration_answer_completion_inbox_recover
      ON integration_answer_completion_inbox(state, updated_at);

    CREATE TABLE IF NOT EXISTS integration_answer_completion_cancellations (
      delivery_id TEXT PRIMARY KEY,
      cancelled_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_workflow_bindings (
      workflow_handle TEXT PRIMARY KEY,
      native_session_id TEXT NOT NULL,
      native_flow_id TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_cursors (
      stream TEXT PRIMARY KEY,
      cursor TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_firing_authorities (
      delivery_id TEXT PRIMARY KEY,
      firing_id TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_integration_firing_authorities_session
      ON integration_firing_authorities(native_session_id, firing_id);

    -- The authority a woken run reports its outcome through, and whether that
    -- run is known to have ended waiting on something.
    --
    -- Separate from the firing authority because the two expire on different
    -- clocks: an inbound report has to stay postable long after the outbound
    -- answer authority is gone.
    --
    -- Keyed by delivery, and read that way. Every firing of one workflow runs
    -- in the same native session, so a session names a workflow rather than a
    -- firing: resolving a report through it would file whatever one run said
    -- against whichever sibling firing was most recently woken.
    CREATE TABLE IF NOT EXISTS integration_outcome_authorities (
      delivery_id TEXT PRIMARY KEY,
      firing_id TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      deferred INTEGER NOT NULL DEFAULT 0,
      -- The held answer whose release re-enters this run, while it waits on
      -- one. It is what identifies the firing to a resumed turn, which knows
      -- the answer it is delivering and nothing else about the run that asked.
      deferred_answer TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
    // An inbox created before answers were allowed a second try has the table
    // without the column. Added here rather than in a rebuild because it is
    // additive and defaulted: an existing ambiguous row starts from zero, which
    // is the same budget a fresh one gets.
    const answerColumns = db
      .prepare("PRAGMA table_info(integration_answer_completion_inbox)")
      .all() as { name?: unknown }[];
    if (!answerColumns.some((column) => column.name === "start_attempts")) {
      db.exec(
        "ALTER TABLE integration_answer_completion_inbox ADD COLUMN start_attempts INTEGER NOT NULL DEFAULT 0",
      );
    }

    // An inbox created before a deferral named the answer it waits on has the
    // table without the column. Additive and nullable: a row carried over waits
    // on nothing, which is what a run that is not deferred says anyway.
    const outcomeColumns = db
      .prepare("PRAGMA table_info(integration_outcome_authorities)")
      .all() as { name?: unknown }[];
    if (!outcomeColumns.some((column) => column.name === "deferred_answer")) {
      db.exec("ALTER TABLE integration_outcome_authorities ADD COLUMN deferred_answer TEXT");
    }
    // Stated after the column exists, so an older store is indexed on the
    // column the same statement just added. The session index it replaces has
    // no reader: nothing resolves an outcome through a session any more.
    db.exec(`
      DROP INDEX IF EXISTS idx_integration_outcome_authorities_session;
      CREATE INDEX IF NOT EXISTS idx_integration_outcome_authorities_deferred
        ON integration_outcome_authorities(deferred_answer);
    `);

    const inboxSql = getRow<{ sql: string }>(
      db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'integration_inbox'",
      ),
    )?.sql;
    if (inboxSql?.includes("'received'")) {
      inTransaction(db, () => {
        db.exec(`
        DROP INDEX IF EXISTS idx_integration_inbox_recover;
        ALTER TABLE integration_inbox RENAME TO integration_inbox_legacy;
        CREATE TABLE integration_inbox (
          delivery_id TEXT PRIMARY KEY,
          payload_hash TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','starting','accepted','cancelled')),
          accepted_at INTEGER,
          local_run_id TEXT,
          last_error TEXT,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO integration_inbox (
          delivery_id, payload_hash, payload_json, state, accepted_at,
          local_run_id, last_error, updated_at
        )
        SELECT delivery_id, payload_hash, payload_json,
               CASE
                 WHEN state IN ('received','retryable_failure') THEN 'prepared'
                 ELSE state
               END,
               accepted_at, local_run_id, last_error, updated_at
          FROM integration_inbox_legacy;
        DROP TABLE integration_inbox_legacy;
        CREATE INDEX idx_integration_inbox_recover
          ON integration_inbox(state, updated_at);
      `);
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

interface OutcomeAuthorityRow {
  delivery_id: string;
  firing_id: string;
  native_session_id: string;
  endpoint: string;
  token: string;
  expires_at: number;
  deferred: number;
}

/** Every read of an outcome authority selects the same shape. */
const SELECT_OUTCOME_AUTHORITY = `
  SELECT delivery_id, firing_id, native_session_id, endpoint, token, expires_at, deferred
    FROM integration_outcome_authorities`;

function outcomeAuthorityOf(row: OutcomeAuthorityRow): OutcomeAuthority {
  return {
    deliveryId: row.delivery_id,
    firingId: row.firing_id,
    nativeSessionId: row.native_session_id,
    endpoint: row.endpoint,
    token: row.token,
    expiresAt: row.expires_at,
    deferred: row.deferred !== 0,
  };
}

function getRow<T>(statement: StatementSync, ...parameters: SQLInputValue[]): T | undefined {
  return statement.get(...parameters) as T | undefined;
}

function inTransaction<T>(db: Db, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export class DurableIntegrationInbox {
  private readonly db: Db;
  private readonly inFlight = new Map<string, Promise<DeliveryAcceptance>>();
  private readonly completionInFlight = new Map<string, Promise<DeliveryAcceptance>>();

  constructor(
    path: string,
    private readonly hooks: DurableIntegrationInboxHooks = {},
  ) {
    this.db = openPrivateDatabase(path);
  }

  close(): void {
    this.db.close();
  }

  getWorkflowBinding(workflowHandle: string): WorkflowBinding | null {
    const row = getRow<BindingRow>(
      this.db.prepare(
        `SELECT workflow_handle, native_session_id, native_flow_id, updated_at
           FROM integration_workflow_bindings WHERE workflow_handle = ?`,
      ),
      workflowHandle,
    );
    return row
      ? {
          workflowHandle: row.workflow_handle,
          nativeSessionId: row.native_session_id,
          nativeFlowId: row.native_flow_id,
          updatedAt: row.updated_at,
        }
      : null;
  }

  getCursor(stream: string): string | null {
    const row = getRow<{ cursor: string }>(
      this.db.prepare("SELECT cursor FROM integration_cursors WHERE stream = ?"),
      stream,
    );
    return row?.cursor ?? null;
  }

  setCursor(stream: string, cursor: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO integration_cursors (stream, cursor, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(stream) DO UPDATE SET
           cursor = excluded.cursor,
           updated_at = excluded.updated_at`,
      )
      .run(stream, cursor, now);
  }

  getState(deliveryId: string): InboxState | null {
    const row = this.readRow(deliveryId);
    return row?.state ?? null;
  }

  getAnswerCompletionState(deliveryId: string): InboxState | null {
    return this.readAnswerCompletionRow(deliveryId)?.state ?? null;
  }

  /** Persist a terminal Answer wake before acknowledging its prepare frame. */
  prepareAnswerCompletion(
    untrustedDelivery: unknown,
    now: number = Date.now(),
  ): DeliveryPreparation {
    const delivery = answerCompletionDeliverySchema.parse(untrustedDelivery);
    const hash = answerCompletionDeliveryHash(delivery);
    const inserted = inTransaction(this.db, () => {
      if (this.isAnswerCompletionCancelled(delivery.deliveryId)) {
        throw new DeliveryCancelledError(delivery.deliveryId);
      }
      const existing = this.readAnswerCompletionRow(delivery.deliveryId);
      if (existing) {
        if (existing.payload_hash !== hash) throw new DeliveryConflictError(delivery.deliveryId);
        this.db
          .prepare(
            `UPDATE integration_answer_completion_inbox
                SET payload_hash = ?, payload_json = ?, updated_at = ?
              WHERE delivery_id = ?`,
          )
          .run(hash, JSON.stringify(delivery), now, delivery.deliveryId);
        return false;
      }
      this.db
        .prepare(
          `INSERT INTO integration_answer_completion_inbox (
             delivery_id, payload_hash, payload_json, state, updated_at
           ) VALUES (?, ?, ?, 'prepared', ?)`,
        )
        .run(delivery.deliveryId, hash, JSON.stringify(delivery), now);
      return true;
    });
    return { status: "prepared", preparedAt: now, duplicate: !inserted };
  }

  /** Invoke completion delivery only after its durable commit frame arrives. */
  async commitAnswerCompletion(
    deliveryId: string,
    starter: AnswerCompletionStarter,
    now: number = Date.now(),
  ): Promise<DeliveryAcceptance> {
    const active = this.completionInFlight.get(deliveryId);
    if (active) return { ...(await active), duplicate: true };
    const claim = this.claimAnswerCompletionForStart(deliveryId, now);
    if (claim.kind === "accepted") return claim.acceptance;
    const work = this.startAnswerCompletionAndPersist(claim.delivery, starter);
    this.completionInFlight.set(deliveryId, work);
    try {
      return await work;
    } finally {
      this.completionInFlight.delete(deliveryId);
    }
  }

  cancelAnswerCompletion(deliveryId: string, now: number = Date.now()): DeliveryCancellation {
    return inTransaction(this.db, () => {
      const row = this.readAnswerCompletionRow(deliveryId);
      if (row?.state === "starting" || row?.state === "accepted") {
        return { status: "too_late", cancelledAt: now, duplicate: false };
      }
      const existing = this.isAnswerCompletionCancelled(deliveryId);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO integration_answer_completion_cancellations
             (delivery_id, cancelled_at) VALUES (?, ?)`,
        )
        .run(deliveryId, now);
      if (row) {
        this.db
          .prepare(
            `UPDATE integration_answer_completion_inbox
                SET state = 'cancelled', last_error = NULL, updated_at = ?
              WHERE delivery_id = ?`,
          )
          .run(now, deliveryId);
      }
      return { status: "cancelled", cancelledAt: now, duplicate: existing };
    });
  }

  putFiringAuthority(
    untrustedDelivery: unknown,
    nativeSessionId: string,
    now: number = Date.now(),
  ): void {
    const delivery = subscriptionDeliverySchema.parse(untrustedDelivery);
    if (!nativeSessionId) throw new Error("native session identity is required");
    inTransaction(this.db, () => {
      this.db.prepare("DELETE FROM integration_firing_authorities WHERE expires_at <= ?").run(now);
      this.db
        .prepare(
          `INSERT INTO integration_firing_authorities (
             delivery_id, firing_id, native_session_id, endpoint, token, expires_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(delivery_id) DO UPDATE SET
             firing_id = excluded.firing_id,
             native_session_id = excluded.native_session_id,
             endpoint = excluded.endpoint,
             token = excluded.token,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          delivery.deliveryId,
          delivery.firingId,
          nativeSessionId,
          delivery.answer.endpoint,
          delivery.answer.token,
          delivery.answer.expiresAt,
          now,
        );
    });
  }

  getFiringAuthority(
    nativeSessionId: string,
    firingId: string,
    now: number = Date.now(),
  ): FiringAuthority | null {
    this.db.prepare("DELETE FROM integration_firing_authorities WHERE expires_at <= ?").run(now);
    const row = getRow<{
      delivery_id: string;
      firing_id: string;
      native_session_id: string;
      endpoint: string;
      token: string;
      expires_at: number;
    }>(
      this.db.prepare(
        `SELECT delivery_id, firing_id, native_session_id, endpoint, token, expires_at
           FROM integration_firing_authorities
          WHERE native_session_id = ? AND firing_id = ? AND expires_at > ?`,
      ),
      nativeSessionId,
      firingId,
      now,
    );
    return row
      ? {
          deliveryId: row.delivery_id,
          firingId: row.firing_id,
          nativeSessionId: row.native_session_id,
          endpoint: row.endpoint,
          token: row.token,
          expiresAt: row.expires_at,
        }
      : null;
  }

  /**
   * Bind this firing's outcome authority to the session about to run it.
   *
   * Written before the run starts and kept until that firing has reported, so
   * a run resumed by an answer released days later — in a process that never
   * saw the original wake — still has somewhere to report. It outlives the run
   * rather than the watch: nothing scans this table at startup, so a run whose
   * end went unobserved because the plugin was down is never reported on,
   * there being nobody left who can say how it went. A wake that carried no
   * outcome authority records nothing, and that run reports nothing.
   */
  putOutcomeAuthority(
    untrustedDelivery: unknown,
    nativeSessionId: string,
    now: number = Date.now(),
  ): void {
    const delivery = subscriptionDeliverySchema.parse(untrustedDelivery);
    const outcome = deliveryOutcomeAuthority(delivery);
    if (!outcome) return;
    if (!nativeSessionId) throw new Error("native session identity is required");
    inTransaction(this.db, () => {
      this.db.prepare("DELETE FROM integration_outcome_authorities WHERE expires_at <= ?").run(now);
      this.db
        .prepare(
          `INSERT INTO integration_outcome_authorities (
             delivery_id, firing_id, native_session_id, endpoint, token, expires_at,
             deferred, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(delivery_id) DO UPDATE SET
             native_session_id = excluded.native_session_id,
             endpoint = excluded.endpoint,
             token = excluded.token,
             expires_at = excluded.expires_at,
             deferred = 0,
             deferred_answer = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(
          delivery.deliveryId,
          delivery.firingId,
          nativeSessionId,
          outcome.endpoint,
          outcome.token,
          outcome.expiresAt,
          now,
        );
    });
  }

  /** The live authority this firing's run reports through, if it has one. */
  getOutcomeAuthority(deliveryId: string, now: number = Date.now()): OutcomeAuthority | null {
    const row = getRow<OutcomeAuthorityRow>(
      this.db.prepare(
        `${SELECT_OUTCOME_AUTHORITY}
          WHERE delivery_id = ? AND expires_at > ?`,
      ),
      deliveryId,
      now,
    );
    return row ? outcomeAuthorityOf(row) : null;
  }

  /**
   * Record that this firing's run ended waiting on a held answer, and name the
   * answer whose release will re-enter it.
   *
   * The answer is named because the resumed turn knows only which answer it is
   * delivering: it is a fresh turn in a session shared by every firing of the
   * workflow, so nothing else there tells it which firing asked. The handle is
   * derived from the firing-bound answer endpoint, so it names exactly one.
   */
  deferOutcome(deliveryId: string, answerHandle: string, now: number = Date.now()): void {
    if (!answerHandle) throw new Error("a deferred run must name the answer it waits on");
    this.db
      .prepare(
        `UPDATE integration_outcome_authorities
            SET deferred = 1, deferred_answer = ?, updated_at = ?
          WHERE delivery_id = ? AND expires_at > ?`,
      )
      .run(answerHandle, now, deliveryId, now);
  }

  /**
   * The firing whose run was waiting on this answer, no longer deferred.
   *
   * Null when no run waits on it — an ordinary conversation ask, or a firing
   * whose authority has expired since. The answer is delivered either way; a
   * firing that cannot be named simply has nothing reported for it.
   */
  resumeDeferredOutcome(answerHandle: string, now: number = Date.now()): OutcomeAuthority | null {
    if (!answerHandle) return null;
    return inTransaction(this.db, () => {
      const row = getRow<OutcomeAuthorityRow>(
        this.db.prepare(
          `${SELECT_OUTCOME_AUTHORITY}
            WHERE deferred_answer = ? AND expires_at > ?
            ORDER BY updated_at DESC
            LIMIT 1`,
        ),
        answerHandle,
        now,
      );
      if (!row) return null;
      this.db
        .prepare(
          `UPDATE integration_outcome_authorities
              SET deferred = 0, deferred_answer = NULL, updated_at = ?
            WHERE delivery_id = ?`,
        )
        .run(now, row.delivery_id);
      return outcomeAuthorityOf({ ...row, deferred: 0 });
    });
  }

  /** Retire an authority whose run has reported a final outcome. */
  clearOutcomeAuthority(deliveryId: string): void {
    this.db
      .prepare("DELETE FROM integration_outcome_authorities WHERE delivery_id = ?")
      .run(deliveryId);
  }

  /**
   * Durably stage a wake without invoking the native harness.
   *
   * A cancellation tombstone wins even when it arrived before a delayed
   * preparation frame, so a revoke cannot be undone by transport reordering.
   */
  prepare(untrustedDelivery: unknown, now: number = Date.now()): DeliveryPreparation {
    const delivery = subscriptionDeliverySchema.parse(untrustedDelivery);
    const hash = deliveryPayloadHash(delivery);
    const inserted = inTransaction(this.db, () => {
      if (this.isCancelled(delivery.deliveryId)) {
        throw new DeliveryCancelledError(delivery.deliveryId);
      }
      const existing = this.readRow(delivery.deliveryId);
      if (existing) {
        if (existing.payload_hash !== hash) throw new DeliveryConflictError(delivery.deliveryId);
        this.db
          .prepare(
            `UPDATE integration_inbox
                SET payload_json = ?, updated_at = ?
              WHERE delivery_id = ?`,
          )
          .run(JSON.stringify(delivery), now, delivery.deliveryId);
        this.refreshExistingAuthority(delivery, now);
        return false;
      }
      this.db
        .prepare(
          `INSERT INTO integration_inbox (
             delivery_id, payload_hash, payload_json, state, updated_at
           ) VALUES (?, ?, ?, 'prepared', ?)`,
        )
        .run(delivery.deliveryId, hash, JSON.stringify(delivery), now);
      return true;
    });

    const row = this.readRow(delivery.deliveryId);
    if (!row) throw new Error(`failed to persist delivery ${delivery.deliveryId}`);
    return {
      status: "prepared",
      preparedAt: now,
      duplicate: !inserted,
    };
  }

  /**
   * Start a previously prepared wake. The separate call is the privacy
   * release point: the gateway sends it only after atomically revalidating the
   * live subscription, approval, policy, workflow, and firing authority.
   */
  async commit(
    deliveryId: string,
    starter: DeliveryStarter,
    now: number = Date.now(),
  ): Promise<DeliveryAcceptance> {
    const active = this.inFlight.get(deliveryId);
    if (active) {
      const accepted = await active;
      return { ...accepted, duplicate: true };
    }

    const claim = this.claimPreparedForStart(deliveryId, now);
    if (claim.kind === "accepted") return claim.acceptance;
    const work = this.startAndPersist(claim.delivery, starter);
    this.inFlight.set(deliveryId, work);
    try {
      const accepted = await work;
      return accepted;
    } finally {
      this.inFlight.delete(deliveryId);
    }
  }

  cancel(deliveryId: string, now: number = Date.now()): DeliveryCancellation {
    return inTransaction(this.db, () => {
      const row = this.readRow(deliveryId);
      if (row?.state === "starting" || row?.state === "accepted") {
        return {
          status: "too_late",
          cancelledAt: now,
          duplicate: false,
        } as const;
      }
      const existing = this.isCancelled(deliveryId);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO integration_delivery_cancellations
             (delivery_id, cancelled_at) VALUES (?, ?)`,
        )
        .run(deliveryId, now);
      if (row) {
        this.db
          .prepare(
            `UPDATE integration_inbox
                SET state = 'cancelled', last_error = NULL, updated_at = ?
              WHERE delivery_id = ?`,
          )
          .run(now, deliveryId);
      }
      return {
        status: "cancelled",
        cancelledAt: now,
        duplicate: existing,
      } as const;
    });
  }

  private async startAndPersist(
    delivery: SubscriptionDelivery,
    starter: DeliveryStarter,
  ): Promise<DeliveryAcceptance> {
    try {
      const existingBinding = this.getWorkflowBinding(delivery.workflowHandle);
      const native = await starter({ delivery, binding: existingBinding });
      if (!native.localRunId || !native.nativeSessionId) {
        throw new Error("harness did not return a stable run and session identity");
      }
      const acceptedAt = Date.now();
      this.hooks.beforeAcceptanceCommit?.();
      inTransaction(this.db, () => {
        const currentBinding = this.getWorkflowBinding(delivery.workflowHandle);
        if (
          currentBinding &&
          (currentBinding.nativeSessionId !== native.nativeSessionId ||
            currentBinding.nativeFlowId !== (native.nativeFlowId ?? null))
        ) {
          throw new WorkflowBindingConflictError(delivery.workflowHandle);
        }
        this.db
          .prepare(
            `INSERT INTO integration_workflow_bindings (
               workflow_handle, native_session_id, native_flow_id, updated_at
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT(workflow_handle) DO UPDATE SET updated_at = excluded.updated_at`,
          )
          .run(
            delivery.workflowHandle,
            native.nativeSessionId,
            native.nativeFlowId ?? null,
            acceptedAt,
          );
        this.db
          .prepare(
            `UPDATE integration_inbox
                SET state = 'accepted', accepted_at = ?, local_run_id = ?,
                    last_error = NULL, updated_at = ?
              WHERE delivery_id = ?`,
          )
          .run(acceptedAt, native.localRunId, acceptedAt, delivery.deliveryId);
      });
      return {
        status: "accepted",
        acceptedAt,
        localRunId: native.localRunId,
        duplicate: false,
      };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      // Invocation was attempted. Its rejection can itself be a lost native
      // acknowledgement, so preserve `starting` as an explicit ambiguous
      // state. Retrying would violate the at-most-once reaction contract.
      this.db
        .prepare(
          `UPDATE integration_inbox
              SET last_error = ?, updated_at = ?
            WHERE delivery_id = ? AND state <> 'accepted'`,
        )
        .run(message, Date.now(), delivery.deliveryId);
      throw error;
    }
  }

  /**
   * Atomically acquire the sole right to invoke the native harness.
   *
   * The process-local in-flight map coalesces ordinary duplicate frames. This
   * compare-and-set is the durable backstop for overlapping plugin processes
   * or two clients sharing the same SQLite inbox. A cancellation tombstone is
   * part of the write predicate, so a stale pre-cancel read cannot resurrect a
   * cancelled delivery.
   */
  private claimPreparedForStart(deliveryId: string, now: number): DeliveryStartClaim {
    if (this.isCancelled(deliveryId)) throw new DeliveryCancelledError(deliveryId);
    const row = this.readRow(deliveryId);
    if (!row) throw new DeliveryNotPreparedError(deliveryId);
    if (row.state === "cancelled") throw new DeliveryCancelledError(deliveryId);
    if (row.state === "accepted") {
      return { kind: "accepted", acceptance: this.acceptanceFromRow(row, true) };
    }
    // Once native invocation begins, a process crash or transport error leaves
    // no durable OpenClaw receipt that proves whether the run was accepted.
    // At-most-once delivery therefore parks the row instead of risking a
    // duplicate reaction. A future harness receipt API can reconcile it.
    if (row.state === "starting") throw new AmbiguousDeliveryError(deliveryId);

    const delivery = subscriptionDeliverySchema.parse(JSON.parse(row.payload_json));
    if (delivery.answer.expiresAt <= now) {
      throw new DeliveryAuthorityExpiredError(deliveryId);
    }
    this.hooks.beforeStartClaim?.();
    const changed = this.db
      .prepare(
        `UPDATE integration_inbox
            SET state = 'starting', last_error = NULL, updated_at = ?
          WHERE delivery_id = ? AND state = 'prepared'
            AND NOT EXISTS (
              SELECT 1 FROM integration_delivery_cancellations
               WHERE delivery_id = ?
            )`,
      )
      .run(now, deliveryId, deliveryId);
    if (changed.changes === 1) return { kind: "start", delivery };

    if (this.isCancelled(deliveryId)) throw new DeliveryCancelledError(deliveryId);
    const current = this.readRow(deliveryId);
    if (!current) throw new DeliveryNotPreparedError(deliveryId);
    if (current.state === "cancelled") throw new DeliveryCancelledError(deliveryId);
    if (current.state === "accepted") {
      return { kind: "accepted", acceptance: this.acceptanceFromRow(current, true) };
    }
    if (current.state === "starting") throw new AmbiguousDeliveryError(deliveryId);
    throw new DeliveryNotPreparedError(deliveryId);
  }

  private refreshExistingAuthority(delivery: SubscriptionDelivery, now: number): void {
    this.db
      .prepare(
        `UPDATE integration_firing_authorities
            SET token = ?, expires_at = ?, endpoint = ?, updated_at = ?
          WHERE delivery_id = ? AND firing_id = ?`,
      )
      .run(
        delivery.answer.token,
        delivery.answer.expiresAt,
        delivery.answer.endpoint,
        now,
        delivery.deliveryId,
        delivery.firingId,
      );
  }

  private async startAnswerCompletionAndPersist(
    delivery: AnswerCompletionDelivery,
    starter: AnswerCompletionStarter,
  ): Promise<DeliveryAcceptance> {
    try {
      await starter(delivery);
      const acceptedAt = Date.now();
      this.hooks.beforeAcceptanceCommit?.();
      this.db
        .prepare(
          `UPDATE integration_answer_completion_inbox
              SET state = 'accepted', accepted_at = ?, local_run_id = ?,
                  last_error = NULL, updated_at = ?
            WHERE delivery_id = ? AND state = 'starting'`,
        )
        .run(acceptedAt, delivery.deliveryId, acceptedAt, delivery.deliveryId);
      return {
        status: "accepted",
        acceptedAt,
        localRunId: delivery.deliveryId,
        duplicate: false,
      };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.db
        .prepare(
          `UPDATE integration_answer_completion_inbox
              SET last_error = ?, updated_at = ?
            WHERE delivery_id = ? AND state <> 'accepted'`,
        )
        .run(message, Date.now(), delivery.deliveryId);
      throw error;
    }
  }

  private claimAnswerCompletionForStart(
    deliveryId: string,
    now: number,
  ): AnswerCompletionStartClaim {
    if (this.isAnswerCompletionCancelled(deliveryId)) {
      throw new DeliveryCancelledError(deliveryId);
    }
    const row = this.readAnswerCompletionRow(deliveryId);
    if (!row) throw new DeliveryNotPreparedError(deliveryId);
    if (row.state === "cancelled") throw new DeliveryCancelledError(deliveryId);
    if (row.state === "accepted")
      return { kind: "accepted", acceptance: this.acceptanceFromRow(row, true) };
    if (row.state === "starting") return this.retryAmbiguousAnswerCompletion(row, now);
    const delivery = answerCompletionDeliverySchema.parse(JSON.parse(row.payload_json));
    this.hooks.beforeStartClaim?.();
    const changed = this.db
      .prepare(
        `UPDATE integration_answer_completion_inbox
            SET state = 'starting', start_attempts = start_attempts + 1,
                last_error = NULL, updated_at = ?
          WHERE delivery_id = ? AND state = 'prepared'
            AND NOT EXISTS (
              SELECT 1 FROM integration_answer_completion_cancellations
               WHERE delivery_id = ?
            )`,
      )
      .run(now, deliveryId, deliveryId);
    if (changed.changes === 1) return { kind: "start", delivery };
    if (this.isAnswerCompletionCancelled(deliveryId)) throw new DeliveryCancelledError(deliveryId);
    const current = this.readAnswerCompletionRow(deliveryId);
    if (!current) throw new DeliveryNotPreparedError(deliveryId);
    if (current.state === "cancelled") throw new DeliveryCancelledError(deliveryId);
    if (current.state === "accepted") {
      return { kind: "accepted", acceptance: this.acceptanceFromRow(current, true) };
    }
    if (current.state === "starting") return this.retryAmbiguousAnswerCompletion(current, now);
    throw new DeliveryNotPreparedError(deliveryId);
  }

  /**
   * Post an answer again at a harness that never said whether the last one
   * landed, while there is budget for it.
   *
   * The compare-and-set on the attempt count is what keeps two overlapping
   * plugin processes from spending the whole budget at once: both read the same
   * count, only one write matches it, and the loser is told the delivery is
   * ambiguous — which, for that caller, it is.
   */
  private retryAmbiguousAnswerCompletion(
    row: AnswerCompletionInboxRow,
    now: number,
  ): AnswerCompletionStartClaim {
    if (row.start_attempts >= ANSWER_COMPLETION_START_ATTEMPTS) {
      throw new AmbiguousDeliveryError(row.delivery_id);
    }
    const delivery = answerCompletionDeliverySchema.parse(JSON.parse(row.payload_json));
    this.hooks.beforeStartClaim?.();
    const changed = this.db
      .prepare(
        `UPDATE integration_answer_completion_inbox
            SET start_attempts = start_attempts + 1, updated_at = ?
          WHERE delivery_id = ? AND state = 'starting' AND start_attempts = ?
            AND NOT EXISTS (
              SELECT 1 FROM integration_answer_completion_cancellations
               WHERE delivery_id = ?
            )`,
      )
      .run(now, row.delivery_id, row.start_attempts, row.delivery_id);
    if (changed.changes !== 1) throw new AmbiguousDeliveryError(row.delivery_id);
    return { kind: "start", delivery };
  }

  private readRow(deliveryId: string): InboxRow | undefined {
    return getRow<InboxRow>(
      this.db.prepare("SELECT * FROM integration_inbox WHERE delivery_id = ?"),
      deliveryId,
    );
  }

  private readAnswerCompletionRow(deliveryId: string): AnswerCompletionInboxRow | undefined {
    return getRow<AnswerCompletionInboxRow>(
      this.db.prepare("SELECT * FROM integration_answer_completion_inbox WHERE delivery_id = ?"),
      deliveryId,
    );
  }

  private isCancelled(deliveryId: string): boolean {
    return (
      getRow<{ present: number }>(
        this.db.prepare(
          "SELECT 1 AS present FROM integration_delivery_cancellations WHERE delivery_id = ?",
        ),
        deliveryId,
      ) !== undefined
    );
  }

  private isAnswerCompletionCancelled(deliveryId: string): boolean {
    return (
      getRow<{ present: number }>(
        this.db.prepare(
          "SELECT 1 AS present FROM integration_answer_completion_cancellations WHERE delivery_id = ?",
        ),
        deliveryId,
      ) !== undefined
    );
  }

  private acceptanceFromRow(row: InboxRow, duplicate: boolean): DeliveryAcceptance {
    if (row.accepted_at === null || row.local_run_id === null) {
      throw new Error(`accepted delivery ${row.delivery_id} is missing its stable identity`);
    }
    return {
      status: "accepted",
      acceptedAt: row.accepted_at,
      localRunId: row.local_run_id,
      duplicate,
    };
  }
}
