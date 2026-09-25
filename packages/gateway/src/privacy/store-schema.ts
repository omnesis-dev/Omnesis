// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPrivacyPolicyHistoryTables } from "./policy-history.js";
import type { PrivacyDb } from "./store-types.js";

/** Install the protocol-neutral persistence used by the external answer boundary. */
export function createAnswerPrivacyTables(db: PrivacyDb): void {
  createPrivacyPolicyHistoryTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS answer_workflows (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'closed', 'expired')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_answer_workflows_owner
      ON answer_workflows(owner_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS answer_workflow_disclosure (
      workflow_id TEXT PRIMARY KEY REFERENCES answer_workflows(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0,
      released_turns INTEGER NOT NULL DEFAULT 0,
      released_characters INTEGER NOT NULL DEFAULT 0,
      categories_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS answer_conversations (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES answer_workflows(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      active_task_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_answer_conversations_workflow
      ON answer_conversations(workflow_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS answer_tasks (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES answer_workflows(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES answer_conversations(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      subscription_firing_id TEXT,
      completion_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
      completion_native_conversation_id TEXT,
      question TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN (
          'running', 'approval_required', 'released',
          'released_with_reductions', 'denied', 'failed', 'canceled'
        )),
      candidate_answer TEXT,
      candidate_digest TEXT,
      policy_revision TEXT,
      review_json TEXT,
      reductions_json TEXT,
      release_id TEXT,
      approval_id TEXT,
      denial_reason TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      UNIQUE(owner_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_answer_tasks_conversation
      ON answer_tasks(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_answer_tasks_owner
      ON answer_tasks(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_answer_tasks_created_at
      ON answer_tasks(created_at DESC);

    CREATE TABLE IF NOT EXISTS answer_completion_deliveries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE REFERENCES answer_tasks(id) ON DELETE CASCADE,
      integration_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      native_conversation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'claimed', 'retry', 'commit_authorized', 'delivered', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      claim_id TEXT,
      claimed_at INTEGER,
      claim_expires_at INTEGER,
      next_attempt_at INTEGER,
      accepted_at INTEGER,
      local_run_id TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_answer_completion_deliveries_due
      ON answer_completion_deliveries(status, next_attempt_at, claim_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_answer_completion_deliveries_device
      ON answer_completion_deliveries(integration_device_id, status, created_at);
    CREATE TABLE IF NOT EXISTS answer_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES answer_conversations(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES answer_tasks(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_answer_messages_conversation
      ON answer_messages(conversation_id, id);

    CREATE TABLE IF NOT EXISTS answer_approvals (
      id TEXT PRIMARY KEY,
      task_id TEXT UNIQUE NOT NULL REFERENCES answer_tasks(id) ON DELETE CASCADE,
      candidate_digest TEXT NOT NULL,
      candidate_answer TEXT,
      policy_revision TEXT NOT NULL,
      release_status TEXT NOT NULL DEFAULT 'released'
        CHECK (release_status IN ('released', 'released_with_reductions')),
      reductions_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_answer_approvals_status
      ON answer_approvals(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS answer_releases (
      id TEXT PRIMARY KEY,
      task_id TEXT UNIQUE NOT NULL REFERENCES answer_tasks(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      answer TEXT NOT NULL,
      reductions_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_answer_releases_owner
      ON answer_releases(owner_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS answer_audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES answer_conversations(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES answer_tasks(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      display_json TEXT NOT NULL,
      payload_id TEXT,
      payload_digest TEXT,
      payload_bytes INTEGER NOT NULL DEFAULT 0,
      original_payload_bytes INTEGER NOT NULL DEFAULT 0,
      payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK (payload_truncated IN (0, 1)),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_answer_audit_conversation
      ON answer_audit_events(conversation_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_answer_audit_task
      ON answer_audit_events(task_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_answer_audit_owner
      ON answer_audit_events(owner_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS answer_audit_payloads (
      id TEXT PRIMARY KEY,
      event_id TEXT UNIQUE NOT NULL REFERENCES answer_audit_events(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS answer_egress_payloads (
      digest TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      response_bytes INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS answer_egress_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES answer_tasks(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES answer_conversations(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      response_digest TEXT NOT NULL REFERENCES answer_egress_payloads(digest),
      subscription_firing_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_answer_egress_conversation
      ON answer_egress_events(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_answer_egress_task
      ON answer_egress_events(task_id);

    CREATE TABLE IF NOT EXISTS answer_conversation_tombstones (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      egress_count INTEGER NOT NULL DEFAULT 0,
      last_egress_at INTEGER,
      release_digests_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS answer_request_tombstones (
      owner_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, client_request_id)
    );

    -- Legacy workflow-allowance ledger. The feature is retired, but this table
    -- remains part of the append-only schema so older databases upgrade cleanly
    -- and historical rows keep their referential meaning. Answer and privacy
    -- administration paths ignore these rows; workflow cleanup reads only their
    -- existence so it does not orphan historical records.
    CREATE TABLE IF NOT EXISTS answer_workflow_grants (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES answer_workflows(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      approval_id TEXT,
      category TEXT NOT NULL,
      category_key TEXT NOT NULL,
      subject TEXT NOT NULL,
      max_detail_level TEXT NOT NULL
        CHECK (max_detail_level IN ('existence', 'summary', 'exact', 'original')),
      policy_revision TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_answer_grants_workflow
      ON answer_workflow_grants(workflow_id, owner_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_answer_grants_owner
      ON answer_workflow_grants(owner_id, created_at DESC);
  `);
  createAnswerApprovalListIndexes(db);
}

export function createAnswerApprovalListIndexes(db: PrivacyDb): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_answer_approvals_page
      ON answer_approvals(status, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_answer_approvals_all_page
      ON answer_approvals(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_answer_approvals_effective_status
      ON answer_approvals(status, expires_at);
  `);
}

/**
 * Transcript persistence for the Direct MCP boundary. Mirrors the Answer
 * audit mechanics (display/payload split, byte caps enforced by the writer)
 * in separate tables with separate budgets, so a chatty Direct agent can
 * neither starve Answer audits nor have its own transcript truncated by
 * Answer traffic. A session is either explicit (the caller supplied a
 * conversationId/workflowId grouping key) or heuristic (caller activity
 * grouped per principal+credential with a 1h idle split).
 */
export function createDirectAuditTables(db: PrivacyDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS direct_audit_sessions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      explicit_key TEXT,
      heuristic_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_event_at INTEGER NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      bytes_total INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_direct_sessions_owner
      ON direct_audit_sessions(owner_id, last_event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_direct_sessions_explicit
      ON direct_audit_sessions(owner_id, principal_id, credential_id, explicit_key)
      WHERE explicit_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_direct_sessions_heuristic
      ON direct_audit_sessions(owner_id, heuristic_key, last_event_at DESC);

    CREATE TABLE IF NOT EXISTS direct_audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      session_id TEXT NOT NULL REFERENCES direct_audit_sessions(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      outcome TEXT NOT NULL
        CHECK (outcome IN ('ok', 'refused', 'cancelled', 'timed_out', 'failed')),
      request_id TEXT NOT NULL,
      display_json TEXT NOT NULL,
      payload_id TEXT,
      payload_digest TEXT,
      payload_bytes INTEGER NOT NULL DEFAULT 0,
      original_payload_bytes INTEGER NOT NULL DEFAULT 0,
      payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK (payload_truncated IN (0, 1)),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_direct_events_session
      ON direct_audit_events(session_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_direct_events_owner
      ON direct_audit_events(owner_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS direct_audit_payloads (
      id TEXT PRIMARY KEY,
      event_id TEXT UNIQUE NOT NULL REFERENCES direct_audit_events(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL
    );
  `);
}
