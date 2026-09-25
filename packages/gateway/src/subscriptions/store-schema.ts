// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "../data/types.js";

/**
 * Install subscription persistence.
 *
 * Revision rows are immutable. The private compiled plan and evidence rows
 * intentionally have no public DTO counterpart.
 */
export function createSubscriptionTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      integration_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL REFERENCES answer_workflows(id) ON DELETE CASCADE,
      client_request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      current_revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending_approval'
        CHECK (status IN (
          'pending_approval', 'active', 'paused', 'denied', 'revoked', 'expired'
        )),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      -- Why the record was revoked, when something other than a person revoked
      -- it. NULL is a person's decision — the operator taking a watch back, or
      -- the integration withdrawing its own — and no repair may overturn one.
      -- A machine revoking as a step of a larger change stamps its own reason,
      -- so a change interrupted between the two steps can be recognised and
      -- finished instead of read as somebody's answer.
      revoked_reason TEXT,
      UNIQUE(owner_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_device
      ON subscriptions(integration_device_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_status
      ON subscriptions(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS subscription_revisions (
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      workflow_id TEXT NOT NULL REFERENCES answer_workflows(id) ON DELETE CASCADE,
      condition_json TEXT NOT NULL,
      reaction_json TEXT NOT NULL,
      interpretation_json TEXT NOT NULL,
      -- Compile-time measurement of a catalog watch against live analytics.
      -- NULL whenever nothing was measured: a document-event plan, an
      -- unavailable analytics database, or a revision copied forward.
      grounding_json TEXT,
      -- The subscription_compile cognition run that produced this revision's
      -- plan (its transcript is the compile's inspection surface). Carried
      -- forward when a policy bump copies a revision: the plan is unchanged,
      -- so its compile provenance is too. NULL when no recorder ran or the
      -- revision predates recording.
      --
      -- Deliberately no foreign key: a revision outlives the ledger, whose
      -- rows and transcripts can be pruned by the configured activity
      -- retention window, so an id here can outlive what it names. Readers
      -- must treat a missing run as "aged out", not as corruption.
      compile_run_id TEXT,
      compiled_plan_json TEXT NOT NULL,
      compiler_version TEXT NOT NULL,
      privacy_categories_json TEXT NOT NULL DEFAULT '[]',
      policy_revision TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (subscription_id, revision)
    );

    CREATE TABLE IF NOT EXISTS subscription_approvals (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolved_by_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
      resolved_by_token_id TEXT REFERENCES tokens(id) ON DELETE SET NULL,
      privacy_review_json TEXT,
      disclosure_categories_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(subscription_id, revision),
      FOREIGN KEY (subscription_id, revision)
        REFERENCES subscription_revisions(subscription_id, revision) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_approvals_status
      ON subscription_approvals(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS subscription_grants (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      integration_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL REFERENCES answer_workflows(id) ON DELETE CASCADE,
      approval_id TEXT NOT NULL REFERENCES subscription_approvals(id) ON DELETE CASCADE,
      policy_revision TEXT NOT NULL,
      push_detail TEXT NOT NULL DEFAULT 'existence'
        CHECK (push_detail = 'existence'),
      categories_json TEXT NOT NULL DEFAULT '[]',
      disclosure_categories_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      UNIQUE(subscription_id, revision),
      FOREIGN KEY (subscription_id, revision)
        REFERENCES subscription_revisions(subscription_id, revision) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_grants_active
      ON subscription_grants(subscription_id, revoked_at, expires_at);

    CREATE TABLE IF NOT EXISTS subscription_firings (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      workflow_id TEXT NOT NULL REFERENCES answer_workflows(id) ON DELETE CASCADE,
      index_event_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivered', 'blocked', 'failed')),
      evidence_json TEXT NOT NULL DEFAULT '[]',
      evidence_count INTEGER NOT NULL DEFAULT 0,
      -- What the plan observed satisfying the condition, for a firing that
      -- carries no documents. NULL when the plan reported nothing, and on
      -- every firing recorded before this column existed.
      observation_json TEXT,
      fired_at INTEGER NOT NULL,
      UNIQUE(subscription_id, revision, index_event_key),
      FOREIGN KEY (subscription_id, revision)
        REFERENCES subscription_revisions(subscription_id, revision) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_firings_subscription
      ON subscription_firings(subscription_id, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_subscription_firings_retention
      ON subscription_firings(fired_at, id)
      WHERE status IN ('delivered', 'blocked', 'failed');

    CREATE TABLE IF NOT EXISTS subscription_firing_evidence (
      firing_id TEXT NOT NULL REFERENCES subscription_firings(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      PRIMARY KEY (firing_id, document_id)
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_firing_evidence_document
      ON subscription_firing_evidence(document_id, firing_id);
    CREATE TRIGGER IF NOT EXISTS subscription_firing_evidence_delete_guard
      AFTER DELETE ON subscription_firing_evidence
      BEGIN
        UPDATE subscription_firings
           SET status = 'blocked'
         WHERE id = OLD.firing_id;
        UPDATE subscription_deliveries
           SET status = 'cancel_pending',
               claim_id = CASE WHEN status = 'claimed' THEN claim_id ELSE NULL END,
               claimed_at = CASE WHEN status = 'claimed' THEN claimed_at ELSE NULL END,
               claim_expires_at =
                 CASE WHEN status = 'claimed' THEN claim_expires_at ELSE NULL END,
               next_attempt_at = CAST(strftime('%s','now') AS INTEGER) * 1000,
               last_error = 'firing evidence was privacy-deleted',
               updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
         WHERE firing_id = OLD.firing_id
           AND status IN ('pending', 'claimed', 'retry');
        UPDATE subscription_firing_answer_authorities
           SET revoked_at = COALESCE(
             revoked_at,
             CAST(strftime('%s','now') AS INTEGER) * 1000
           )
         WHERE firing_id = OLD.firing_id
           AND revoked_at IS NULL;
        UPDATE subscription_firing_outcome_authorities
           SET revoked_at = COALESCE(
             revoked_at,
             CAST(strftime('%s','now') AS INTEGER) * 1000
           )
         WHERE firing_id = OLD.firing_id
           AND revoked_at IS NULL;
      END;

    CREATE TABLE IF NOT EXISTS subscription_deliveries (
      id TEXT PRIMARY KEY,
      firing_id TEXT NOT NULL UNIQUE
        REFERENCES subscription_firings(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      integration_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL REFERENCES answer_workflows(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
          'pending', 'claimed', 'retry', 'cancel_pending', 'commit_authorized',
          'manual_review', 'delivered', 'failed'
        )),
      attempts INTEGER NOT NULL DEFAULT 0,
      claim_id TEXT,
      claimed_at INTEGER,
      claim_expires_at INTEGER,
      next_attempt_at INTEGER,
      accepted_at INTEGER,
      local_run_id TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (subscription_id, revision)
        REFERENCES subscription_revisions(subscription_id, revision) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_deliveries_due
      ON subscription_deliveries(status, next_attempt_at, claim_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_subscription_deliveries_device
      ON subscription_deliveries(integration_device_id, status, created_at);

    CREATE TABLE IF NOT EXISTS subscription_firing_answer_authorities (
      id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL UNIQUE REFERENCES tokens(id) ON DELETE CASCADE,
      delivery_id TEXT NOT NULL REFERENCES subscription_deliveries(id) ON DELETE CASCADE,
      firing_id TEXT NOT NULL REFERENCES subscription_firings(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      workflow_id TEXT NOT NULL REFERENCES answer_workflows(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      policy_revision TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      first_used_at INTEGER,
      last_used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      consumed_at INTEGER,
      revoked_at INTEGER,
      UNIQUE(delivery_id, token_id),
      FOREIGN KEY (subscription_id, revision)
        REFERENCES subscription_revisions(subscription_id, revision) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_answer_authority_lookup
      ON subscription_firing_answer_authorities(token_id, firing_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_subscription_answer_authority_subscription
      ON subscription_firing_answer_authorities(subscription_id, revoked_at, expires_at);

    -- Authority to report what one firing's woken workflow did.
    --
    -- Deliberately thinner than the Answer authority beside it, and longer
    -- lived. Nothing leaves the sandbox through it, so the disclosure controls
    -- that bound an Answer -- the policy revision, the grant, the evidence
    -- census -- have nothing to protect here. What it must survive instead is
    -- time: a workflow whose answer waits on the operator's approval finishes
    -- long after every short-lived credential around it has expired, and a
    -- report that arrives to a closed door is the silence this ends.
    CREATE TABLE IF NOT EXISTS subscription_firing_outcome_authorities (
      id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL UNIQUE REFERENCES tokens(id) ON DELETE CASCADE,
      delivery_id TEXT NOT NULL REFERENCES subscription_deliveries(id) ON DELETE CASCADE,
      firing_id TEXT NOT NULL REFERENCES subscription_firings(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      workflow_id TEXT NOT NULL REFERENCES answer_workflows(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      UNIQUE(delivery_id, token_id),
      FOREIGN KEY (subscription_id, revision)
        REFERENCES subscription_revisions(subscription_id, revision) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_outcome_authority_lookup
      ON subscription_firing_outcome_authorities(token_id, firing_id, expires_at);

    -- What the woken run said it did.
    --
    -- One row per firing, not per run: a run that ends waiting for a held
    -- answer reports deferred, and the run that resumes it reports again over
    -- the top. The runs column counts how many reported, so a firing that
    -- reports twice is legible as a resumption rather than a contradiction.
    CREATE TABLE IF NOT EXISTS subscription_firing_outcomes (
      firing_id TEXT PRIMARY KEY REFERENCES subscription_firings(id) ON DELETE CASCADE,
      delivery_id TEXT NOT NULL REFERENCES subscription_deliveries(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      status TEXT NOT NULL
        CHECK (status IN ('completed', 'nothing_to_do', 'failed', 'deferred')),
      report TEXT,
      runs INTEGER NOT NULL DEFAULT 1,
      first_reported_at INTEGER NOT NULL,
      reported_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_firing_outcomes_reported
      ON subscription_firing_outcomes(reported_at DESC);

    CREATE TABLE IF NOT EXISTS subscription_workflow_disclosure (
      workflow_id TEXT PRIMARY KEY REFERENCES answer_workflows(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0,
      existence_signals INTEGER NOT NULL DEFAULT 0,
      categories_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscription_audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      revision INTEGER,
      firing_id TEXT REFERENCES subscription_firings(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      display_json TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subscription_audit
      ON subscription_audit_events(subscription_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_subscription_audit_retention
      ON subscription_audit_events(created_at, sequence);
  `);
  createSubscriptionApprovalListIndexes(db);
}

export function createSubscriptionApprovalListIndexes(db: Db): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_subscription_approvals_page
      ON subscription_approvals(status, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_subscription_approvals_all_page
      ON subscription_approvals(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_subscription_approvals_effective_status
      ON subscription_approvals(status, expires_at);
  `);

  const hasReactionJson = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('subscription_revisions')")
    .all()
    .some((column) => column.name === "reaction_json");
  if (hasReactionJson) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_subscription_revisions_reaction_kind
        ON subscription_revisions(
          CASE WHEN json_valid(reaction_json)
               THEN json_extract(reaction_json, '$.kind') END,
          subscription_id,
          revision
        );
    `);
  }
}
