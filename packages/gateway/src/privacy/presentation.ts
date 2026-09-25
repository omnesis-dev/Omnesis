// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import { assertNever } from "@omnesis/core";
import { isKnownHarness } from "../sources/agent-conversations/meta.js";
import {
  buildReleasedAnswerResponse,
  effectiveApprovalStatus,
  parseReview,
  parseStringArray,
} from "./store-internals.js";
import { PrivacyCursorError, type PrivacyDb } from "./store-types.js";
import { tokenIdOfAnswerOwner } from "./token-answer-owner.js";
import type {
  AnswerTaskAuditStatus,
  PrivacyApprovalStatus,
  PrivacyAnswerAgentTrace,
  PrivacyExchangeFeedPage,
  PrivacyExchangeOutcome,
  PrivacyExchangePresentation,
  PrivacyExchangePresentationPage,
  PrivacyExternalAgentIdentity,
  PrivacyReviewerFallbackCause,
  PrivacyReviewerHealth,
} from "@omnesis/types/privacy";

export const PRIVACY_REVIEWER_HEALTH_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const PRIVACY_REVIEWER_HEALTH_FAILURE_THRESHOLD = 3;

interface ExchangeRow {
  id: string;
  workflow_id: string;
  conversation_id: string;
  owner_id: string;
  question: string;
  status: string;
  review_json: string | null;
  policy_revision: string | null;
  denial_reason: string | null;
  created_at: number;
  resolved_at: number | null;
  workflow_name: string;
  workflow_purpose: string;
  release_id: string | null;
  release_answer: string | null;
  response_reductions_json: string | null;
  release_reductions_json: string | null;
  approval_id: string | null;
  approval_status: string | null;
  approval_candidate_answer: string | null;
  approval_reductions_json: string | null;
  approval_expires_at: number | null;
  approval_resolved_at: number | null;
  candidate_display_json: string | null;
  candidate_payload_json: string | null;
  failure_display_json: string | null;
  failure_payload_json: string | null;
  agent_trace_payload_json: string | null;
}

interface ExchangeCursor {
  createdAt: number;
  id: string;
}

interface ReviewerHealthRow {
  failure_count: number;
  last_failure_at: number | null;
}

interface RecordedEgressRow {
  task_id: string;
  created_at: number;
}

interface AgentTraceRow {
  task_id: string;
  payload_json: string | null;
  created_at: number;
}

interface PresentedAgentTraces {
  traces: PrivacyAnswerAgentTrace[];
  omittedAttempts: number;
}

const MAX_PRESENTED_AGENT_TRACE_ATTEMPTS = 3;
const MAX_PRESENTED_AGENT_TRACE_PAYLOAD_BYTES = 512 * 1024;
const MAX_PRESENTED_AGENT_TRACE_PARTS = 64;
const SAFE_MODEL_FAILURE_TRANSCRIPT_TEXT =
  "The model request failed before producing a final answer.";
const SAFE_MODEL_STOP_TRANSCRIPT_TEXT =
  "The model request was stopped before producing a final answer.";
/** Prefix of the breadcrumb `@omnesis/agent` appends to a turn that failed or was stopped. */
const TERMINAL_TRANSCRIPT_MARKER = "Model request failed: ";

interface ReleaseEvidenceRow {
  id: string;
  workflow_id: string;
  conversation_id: string;
  status: string;
  release_id: string | null;
  release_answer: string | null;
  response_reductions_json: string | null;
}

interface ReleaseEvidence {
  taskId: string;
  workflowId: string;
  conversationId: string;
  status: "released" | "released_with_reductions";
  releaseId: string;
  responseDigest: string;
}

type LatestOutcomeRow = ReleaseEvidenceRow & {
  approval_status: string | null;
  approval_expires_at: number | null;
};

export function getPrivacyReviewerHealth(db: PrivacyDb, now: number): PrivacyReviewerHealth {
  const row = db
    .prepare<[number], ReviewerHealthRow>(
      `SELECT COUNT(*) AS failure_count, MAX(created_at) AS last_failure_at
         FROM answer_tasks
        WHERE created_at >= ?
          AND CASE
                WHEN json_valid(review_json)
                THEN json_extract(review_json, '$.fallbackCause')
                ELSE NULL
              END IN ('not_configured', 'request_failed', 'context_window_exceeded', 'output_truncated', 'invalid_output')`,
    )
    .get(now - PRIVACY_REVIEWER_HEALTH_WINDOW_MS) ?? {
    failure_count: 0,
    last_failure_at: null,
  };
  return {
    status: row.failure_count >= PRIVACY_REVIEWER_HEALTH_FAILURE_THRESHOLD ? "attention" : "ok",
    recentOperationalFailureCount: row.failure_count,
    lastFailureAt: row.last_failure_at,
  };
}

export function listPrivacyExchangePresentations(
  db: PrivacyDb,
  conversationId: string,
  limit = 50,
  cursor?: string,
  now = Date.now(),
  includeAgentTracesTaskId?: string,
): PrivacyExchangePresentationPage | null {
  const conversationExists = db
    .prepare<
      [string],
      { found: number }
    >("SELECT 1 AS found FROM answer_conversations WHERE id = ?")
    .get(conversationId);
  if (!conversationExists) return null;

  const { page, hasMore } = readExchangeRows(db, {
    conversationId,
    limit,
    cursor,
    taskId: includeAgentTracesTaskId,
  });
  const earliest = page.at(-1);
  return {
    // Oldest-first: a conversation detail reads top-down in event order.
    exchanges: presentExchangeRows(db, [...page].reverse(), now, includeAgentTracesTaskId),
    previousCursor: hasMore && earliest ? encodeCursor(earliest.created_at, earliest.id) : null,
  };
}

/**
 * The owner-scoped landing feed: every exchange, newest first, regardless of
 * conversation. `ownerId` scopes the read the way the conversation id does for
 * the detail query; passing none reads every owner, which only the admin
 * surface does.
 */
export function listPrivacyExchangeFeed(
  db: PrivacyDb,
  options: { ownerId?: string; limit?: number; cursor?: string } = {},
  now = Date.now(),
): PrivacyExchangeFeedPage {
  const { page, hasMore } = readExchangeRows(db, {
    ownerId: options.ownerId,
    limit: options.limit ?? 50,
    cursor: options.cursor,
  });
  const oldest = page.at(-1);
  return {
    exchanges: presentExchangeRows(db, page, now),
    nextCursor: hasMore && oldest ? encodeCursor(oldest.created_at, oldest.id) : null,
  };
}

function presentExchangeRows(
  db: PrivacyDb,
  rows: readonly ExchangeRow[],
  now: number,
  includeAgentTracesTaskId?: string,
): PrivacyExchangePresentation[] {
  const identities = privacyExternalAgentIdentities(
    db,
    rows.map((row) => row.owner_id),
  );
  const sharedAtByTaskId = recordedReleaseEgressTimes(
    db,
    rows.map(releaseEvidence).filter((evidence) => evidence !== null),
  );
  const tracesByTaskId =
    includeAgentTracesTaskId && rows.some((row) => row.id === includeAgentTracesTaskId)
      ? recordedAgentTraces(db, [includeAgentTracesTaskId])
      : new Map<string, PresentedAgentTraces>();
  return rows.map((row) =>
    toExchangePresentation(
      row,
      identities.get(row.owner_id) ?? fallbackExternalAgentIdentity(),
      sharedAtByTaskId.get(row.id) ?? null,
      tracesByTaskId.get(row.id)?.traces ?? [],
      tracesByTaskId.get(row.id)?.omittedAttempts ?? 0,
      now,
    ),
  );
}

/**
 * One page of exchange rows, newest first. Both callers share this so the
 * projection can never drift between the feed and the conversation detail.
 */
function readExchangeRows(
  db: PrivacyDb,
  options: {
    conversationId?: string;
    ownerId?: string;
    taskId?: string;
    limit: number;
    cursor?: string;
  },
): { page: ExchangeRow[]; hasMore: boolean } {
  const safeLimit = Math.max(1, Math.min(options.limit, 100));
  const before = options.cursor ? decodeCursor(options.cursor) : null;
  const filters: string[] = [];
  const filterParams: unknown[] = [];
  if (options.conversationId !== undefined) {
    filters.push("t.conversation_id = ?");
    filterParams.push(options.conversationId);
  }
  if (options.ownerId !== undefined) {
    filters.push("t.owner_id = ?");
    filterParams.push(options.ownerId);
  }
  if (options.taskId !== undefined) {
    filters.push("t.id = ?");
    filterParams.push(options.taskId);
  }
  if (before) {
    filters.push("(t.created_at < ? OR (t.created_at = ? AND t.id < ?))");
    filterParams.push(before.createdAt, before.createdAt, before.id);
  }
  const rows = db
    .prepare<unknown[], ExchangeRow>(
      `SELECT t.id, t.workflow_id, t.conversation_id, t.owner_id, t.question,
              t.status, t.review_json, t.policy_revision, t.denial_reason,
              t.created_at, t.resolved_at,
              w.name AS workflow_name, w.purpose AS workflow_purpose,
              t.release_id,
              t.reductions_json AS response_reductions_json,
              r.answer AS release_answer, r.reductions_json AS release_reductions_json,
              a.id AS approval_id, a.status AS approval_status,
              a.candidate_answer AS approval_candidate_answer,
              a.reductions_json AS approval_reductions_json,
              a.expires_at AS approval_expires_at, a.resolved_at AS approval_resolved_at,
              (SELECT candidate.display_json
                 FROM answer_audit_events candidate
                WHERE candidate.task_id = t.id AND candidate.event_type = 'candidate_generated'
                ORDER BY candidate.sequence DESC LIMIT 1) AS candidate_display_json,
              (SELECT payload.payload_json
                 FROM answer_audit_events candidate
                 JOIN answer_audit_payloads payload ON payload.id = candidate.payload_id
                WHERE candidate.task_id = t.id AND candidate.event_type = 'candidate_generated'
                ORDER BY candidate.sequence DESC LIMIT 1) AS candidate_payload_json,
              (SELECT failed.display_json
                 FROM answer_audit_events failed
                WHERE failed.task_id = t.id AND failed.event_type = 'failed'
                ORDER BY failed.sequence DESC LIMIT 1) AS failure_display_json,
              (SELECT payload.payload_json
                 FROM answer_audit_events failed
                 LEFT JOIN answer_audit_payloads payload ON payload.id = failed.payload_id
                WHERE failed.task_id = t.id AND failed.event_type = 'failed'
                ORDER BY failed.sequence DESC LIMIT 1) AS failure_payload_json,
              (SELECT payload.payload_json
                 FROM answer_audit_events trace
                 JOIN answer_audit_payloads payload ON payload.id = trace.payload_id
                WHERE trace.task_id = t.id AND trace.event_type = 'agent_trace'
                ORDER BY trace.sequence DESC LIMIT 1) AS agent_trace_payload_json
         FROM answer_tasks t
         JOIN answer_workflows w ON w.id = t.workflow_id
         LEFT JOIN answer_releases r ON r.task_id = t.id
         LEFT JOIN answer_approvals a ON a.task_id = t.id
        ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?`,
    )
    .all(...filterParams, safeLimit + 1);
  return { page: rows.slice(0, safeLimit), hasMore: rows.length > safeLimit };
}

export function privacyExternalAgentIdentity(
  db: PrivacyDb,
  ownerId: string,
): PrivacyExternalAgentIdentity {
  return (
    privacyExternalAgentIdentities(db, [ownerId]).get(ownerId) ?? fallbackExternalAgentIdentity()
  );
}

/**
 * Who each answer belongs to, for the surfaces that ask the operator to
 * authorise a disclosure.
 *
 * An owner names the OAuth principal and connection, the token a caller
 * presented, or the paired device a gateway-run answer was raised on behalf
 * of, and each form has to resolve: an
 * approval that cannot say who receives the disclosure asks the operator to
 * decide the one question it withholds the answer to. Owners that resolve to
 * neither keep the generic label rather than a guess.
 */
export function privacyExternalAgentIdentities(
  db: PrivacyDb,
  ownerIds: readonly string[],
): Map<string, PrivacyExternalAgentIdentity> {
  const uniqueOwnerIds = [...new Set(ownerIds)];
  const identities = new Map(
    uniqueOwnerIds.map((ownerId) => [ownerId, fallbackExternalAgentIdentity()]),
  );
  if (uniqueOwnerIds.length === 0) return identities;
  resolvePrincipalIdentities(db, uniqueOwnerIds, identities);
  resolveTokenIdentities(db, uniqueOwnerIds, identities);
  resolveIntegrationIdentities(db, uniqueOwnerIds, identities);
  return identities;
}

interface PrincipalOwnerIdentity {
  ownerId: string;
  principalId: string;
  grantId: string;
  grantRevision: number | null;
  credentialId: string;
}

const LEGACY_PRINCIPAL_OWNER_PATTERN =
  /^principal:([^:]+):grant:([^:]+):revision:([1-9][0-9]*):credential:([^:]+):scope:[^:]+$/;
const PRINCIPAL_OWNER_PATTERN =
  /^principal:([^:]+):grant:([^:]+):credential:([^:]+):answer-scope:[^:]+$/;

function parsePrincipalOwner(ownerId: string): PrincipalOwnerIdentity | null {
  const match = PRINCIPAL_OWNER_PATTERN.exec(ownerId);
  if (match) {
    return {
      ownerId,
      principalId: match[1]!,
      grantId: match[2]!,
      grantRevision: null,
      credentialId: match[3]!,
    };
  }
  const legacyMatch = LEGACY_PRINCIPAL_OWNER_PATTERN.exec(ownerId);
  if (!legacyMatch) return null;
  const grantRevision = Number(legacyMatch[3]);
  if (!Number.isSafeInteger(grantRevision)) return null;
  return {
    ownerId,
    principalId: legacyMatch[1]!,
    grantId: legacyMatch[2]!,
    grantRevision,
    credentialId: legacyMatch[4]!,
  };
}

/** OAuth Answer owners: use the owner-approved principal and connection labels. */
function resolvePrincipalIdentities(
  db: PrivacyDb,
  ownerIds: readonly string[],
  identities: Map<string, PrivacyExternalAgentIdentity>,
): void {
  const parsed = ownerIds.map(parsePrincipalOwner).filter((value) => value !== null);
  if (parsed.length === 0) return;
  if (
    !hasColumn(db, "access_principals", "name") ||
    !hasColumn(db, "access_grants", "revision") ||
    !hasColumn(db, "principal_credentials", "label")
  ) {
    return;
  }

  const byCredential = new Map<string, PrincipalOwnerIdentity[]>();
  for (const owner of parsed) {
    const owners = byCredential.get(owner.credentialId) ?? [];
    owners.push(owner);
    byCredential.set(owner.credentialId, owners);
  }
  const placeholders = [...byCredential].map(() => "?").join(", ");
  const rows = db
    .prepare<
      string[],
      {
        credential_id: string;
        credential_label: string;
        grant_id: string;
        grant_revision: number;
        principal_id: string;
        principal_name: string;
      }
    >(
      `SELECT c.id AS credential_id, c.label AS credential_label,
              g.id AS grant_id, g.revision AS grant_revision,
              p.id AS principal_id, p.name AS principal_name
         FROM principal_credentials c
         JOIN access_grants g ON g.id = c.grant_id
         JOIN access_principals p ON p.id = g.principal_id
        WHERE c.id IN (${placeholders})`,
    )
    .all(...byCredential.keys());
  for (const row of rows) {
    for (const owner of byCredential.get(row.credential_id) ?? []) {
      if (
        row.grant_id !== owner.grantId ||
        row.principal_id !== owner.principalId ||
        (owner.grantRevision !== null && row.grant_revision < owner.grantRevision)
      ) {
        continue;
      }
      identities.set(owner.ownerId, {
        ...externalAgentIdentity(row.principal_name, "principal"),
        connectionName: row.credential_label.trim() || null,
      });
    }
  }
}

/** Labels the gateway gives the tokens it mints itself: they name nothing a person chose. */
const GATEWAY_TOKEN_LABELS = new Set(["initial", "paired"]);

/**
 * Owners naming a presented token (built by `tokenAnswerOwnerId`). The caller
 * is the paired device the token belongs to, named as the Devices page names
 * it and carrying its kind; a label someone gave the token itself stays
 * beside it as the connection. One token can own answers under more than one
 * access level, and each of those owners resolves the same way.
 */
function resolveTokenIdentities(
  db: PrivacyDb,
  ownerIds: readonly string[],
  identities: Map<string, PrivacyExternalAgentIdentity>,
): void {
  const ownerIdsByTokenId = new Map<string, string[]>();
  for (const ownerId of ownerIds) {
    const tokenId = tokenIdOfAnswerOwner(ownerId);
    if (!tokenId) continue;
    const owners = ownerIdsByTokenId.get(tokenId) ?? [];
    owners.push(ownerId);
    ownerIdsByTokenId.set(tokenId, owners);
  }
  if (ownerIdsByTokenId.size === 0) return;
  const [tokenNames, tokenDevices, deviceNames, deviceKinds] = probeColumns(db, [
    ["tokens", "name"],
    ["tokens", "device_id"],
    ["devices", "name"],
    ["devices", "kind"],
  ]);
  if (!tokenNames) return;

  const placeholders = [...ownerIdsByTokenId].map(() => "?").join(", ");
  const withDevices = tokenDevices && deviceNames && deviceKinds;
  const rows = db
    .prepare<
      string[],
      { id: string; name: string | null; device_name: string | null; device_kind: string | null }
    >(
      withDevices
        ? `SELECT t.id, t.name, d.name AS device_name, d.kind AS device_kind
             FROM tokens t LEFT JOIN devices d ON d.id = t.device_id
            WHERE t.id IN (${placeholders})`
        : `SELECT id, name, NULL AS device_name, NULL AS device_kind
             FROM tokens WHERE id IN (${placeholders})`,
    )
    .all(...ownerIdsByTokenId.keys());
  for (const row of rows) {
    const tokenLabel = row.name?.trim() || null;
    const deviceName = row.device_name?.trim() || null;
    const displayName = deviceName ?? tokenLabel;
    if (!displayName) continue;
    const connectionName =
      deviceName && tokenLabel && tokenLabel !== deviceName && !GATEWAY_TOKEN_LABELS.has(tokenLabel)
        ? tokenLabel
        : null;
    for (const ownerId of ownerIdsByTokenId.get(row.id) ?? []) {
      identities.set(ownerId, {
        ...externalAgentIdentity(displayName, "token"),
        ...(connectionName ? { connectionName } : {}),
        ...(row.device_kind ? { deviceKind: row.device_kind } : {}),
      });
    }
  }
}

/**
 * Owners shaped `device:<id>`: a wake, whose answer the gateway runs itself on
 * behalf of an anchor rather than for a caller holding a token.
 *
 * The integration is read from the device's own capability, not recovered from
 * the name — a paired device declares which harness it is, and that declaration
 * is what the runtime already routes the wake by. Only a device that declares
 * one resolves; every other kind of device (a phone, the operator's own
 * machine) is not an external agent and keeps the generic label.
 */
function resolveIntegrationIdentities(
  db: PrivacyDb,
  ownerIds: readonly string[],
  identities: Map<string, PrivacyExternalAgentIdentity>,
): void {
  const ownerIdByDeviceId = ownersByPrefix(ownerIds, "device:");
  if (ownerIdByDeviceId.size === 0) return;
  const [capabilities, kinds] = probeColumns(db, [
    ["devices", "capabilities"],
    ["devices", "kind"],
  ]);
  if (!capabilities) return;

  const placeholders = [...ownerIdByDeviceId].map(() => "?").join(", ");
  const rows = db
    .prepare<
      string[],
      { id: string; name: string | null; kind: string | null; harness: string | null }
    >(
      `SELECT id, name, ${kinds ? "kind" : "NULL AS kind"},
              json_extract(capabilities, '$.agentIntegration.harness') AS harness
         FROM devices WHERE id IN (${placeholders})`,
    )
    .all(...ownerIdByDeviceId.keys());
  for (const row of rows) {
    const ownerId = ownerIdByDeviceId.get(row.id);
    const harness = row.harness?.trim();
    if (!ownerId || !harness || !isKnownHarness(harness)) continue;
    identities.set(ownerId, {
      ...integrationAgentIdentity(row.name, harness),
      ...(row.kind ? { deviceKind: row.kind } : {}),
    });
  }
}

/** The ids carried by every owner written under one namespace, keyed back to their owner. */
function ownersByPrefix(ownerIds: readonly string[], prefix: string): Map<string, string> {
  const byId = new Map<string, string>();
  for (const ownerId of ownerIds) {
    if (!ownerId.startsWith(prefix)) continue;
    const id = ownerId.slice(prefix.length);
    if (id) byId.set(id, ownerId);
  }
  return byId;
}

function toExchangePresentation(
  row: ExchangeRow,
  externalAgent: PrivacyExternalAgentIdentity,
  sharedAt: number | null,
  agentTraces: PrivacyAnswerAgentTrace[],
  agentTraceOmittedAttempts: number,
  now: number,
): PrivacyExchangePresentation {
  const approvalStatus = effectiveApprovalStatus(
    normalizeApprovalStatus(row.approval_status),
    row.approval_expires_at,
    now,
  );
  // Present the state the periodic sweep will materialize: a lapsed pending
  // approval renders as an expired denial even before the sweep flips the rows.
  const rawStatus = normalizeTaskStatus(row.status);
  const status =
    rawStatus === "approval_required" && approvalStatus === "expired" ? "denied" : rawStatus;
  const review = row.review_json ? parseReview(row.review_json, row.policy_revision) : null;
  const fallbackCause =
    row.denial_reason === "hard_stop" ? "hard_stop" : normalizeFallbackCause(review?.fallbackCause);
  const isPending = status === "approval_required" && approvalStatus === "pending";
  const externallyShared = sharedAt !== null;
  const parsedFailure =
    status === "failed" || status === "canceled"
      ? parseFailure(
          row.failure_display_json,
          row.failure_payload_json,
          row.agent_trace_payload_json,
        )
      : null;
  const failure = parsedFailure
    ? {
        ...parsedFailure,
        stage:
          row.candidate_display_json !== null || isTechnicalReviewFailure(fallbackCause)
            ? ("privacy_check" as const)
            : ("answer_generation" as const),
      }
    : null;
  const denialReason =
    approvalStatus === "expired" ? "expired" : normalizeDenialReason(row.denial_reason);
  return {
    taskId: row.id,
    conversationId: row.conversation_id,
    workflowId: row.workflow_id,
    externalAgent,
    workflow: { name: row.workflow_name, purpose: row.workflow_purpose },
    question: row.question,
    status,
    outcome: toOutcome(status, externallyShared),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    sharedAt,
    sharedAnswer:
      externallyShared && (status === "released" || status === "released_with_reductions")
        ? row.release_answer
        : null,
    draftAnswer: recordedDraftAnswer(row.candidate_display_json, row.candidate_payload_json),
    pendingCandidate: isPending ? row.approval_candidate_answer : null,
    reductions:
      status === "released" || status === "released_with_reductions"
        ? parseStringArray(row.release_reductions_json)
        : isPending
          ? parseStringArray(row.approval_reductions_json)
          : [],
    approval:
      row.approval_id && approvalStatus && row.approval_expires_at !== null
        ? {
            id: row.approval_id,
            status: approvalStatus,
            expiresAt: row.approval_expires_at,
            resolvedAt: row.approval_resolved_at,
          }
        : null,
    userDecision:
      approvalStatus === "approved"
        ? "approved"
        : row.denial_reason === "hard_stop" && approvalStatus === "denied"
          ? "approved_but_blocked"
          : row.denial_reason === "user_denied"
            ? "denied"
            : approvalStatus === "expired"
              ? "expired"
              : null,
    denialReason,
    review: review
      ? {
          fallbackCause,
          findings: review.findings,
          rationale: review.rationale,
          ...(review.policyFamilyId ? { policyFamilyId: review.policyFamilyId } : {}),
          ...(review.policyFamilyName ? { policyFamilyName: review.policyFamilyName } : {}),
        }
      : null,
    failure,
    agentTraces,
    agentTraceOmittedAttempts,
  };
}

function isTechnicalReviewFailure(fallbackCause: string | null): boolean {
  return (
    fallbackCause === "not_configured" ||
    fallbackCause === "request_failed" ||
    fallbackCause === "context_window_exceeded" ||
    fallbackCause === "output_truncated" ||
    fallbackCause === "invalid_output" ||
    fallbackCause === "low_confidence"
  );
}

function recordedAgentTraces(
  db: PrivacyDb,
  taskIds: readonly string[],
): Map<string, PresentedAgentTraces> {
  if (taskIds.length === 0) return new Map();
  const rows = db
    .prepare<unknown[], AgentTraceRow>(
      `SELECT event.task_id,
            CASE WHEN length(CAST(payload.payload_json AS BLOB)) <= ${MAX_PRESENTED_AGENT_TRACE_PAYLOAD_BYTES}
              THEN payload.payload_json ELSE NULL END AS payload_json,
            event.created_at
       FROM answer_audit_events event
       JOIN answer_audit_payloads payload ON payload.id = event.payload_id
      WHERE event.event_type = 'agent_trace'
        AND event.task_id IN (${taskIds.map(() => "?").join(",")})
      ORDER BY event.sequence DESC`,
    )
    .all(...taskIds);
  const byTaskId = new Map<string, PresentedAgentTraces>();
  const remainingOrdinalByTask = new Map<string, number>();
  for (const row of rows) {
    remainingOrdinalByTask.set(row.task_id, (remainingOrdinalByTask.get(row.task_id) ?? 0) + 1);
  }
  for (const row of rows) {
    const presented = byTaskId.get(row.task_id) ?? { traces: [], omittedAttempts: 0 };
    const attempt = remainingOrdinalByTask.get(row.task_id) ?? 1;
    remainingOrdinalByTask.set(row.task_id, attempt - 1);
    const trace =
      row.payload_json === null ? null : parseAgentTrace(row.payload_json, row.created_at, attempt);
    if (!trace || presented.traces.length >= MAX_PRESENTED_AGENT_TRACE_ATTEMPTS) {
      presented.omittedAttempts += 1;
    } else {
      // SQL is newest-first; prepend so the UI still reads chronologically.
      presented.traces.unshift(trace);
    }
    byTaskId.set(row.task_id, presented);
  }
  return byTaskId;
}

function parseAgentTrace(
  payloadJson: string,
  createdAt: number,
  attempt: number,
): PrivacyAnswerAgentTrace | null {
  try {
    const value: unknown = JSON.parse(payloadJson);
    if (!value || typeof value !== "object") return null;
    const trace = value as Record<string, unknown>;
    if (
      typeof trace.provider !== "string" ||
      typeof trace.model !== "string" ||
      typeof trace.sessionId !== "string" ||
      !Array.isArray(trace.messages)
    )
      return null;
    const sanitized = sanitizePresentedTraceMessages(trace.messages);
    return {
      attempt,
      provider: trace.provider,
      model: trace.model,
      sessionId: trace.sessionId,
      messages: sanitized.messages,
      terminalStopReason:
        typeof trace.terminalStopReason === "string" ? trace.terminalStopReason : null,
      createdAt,
      truncated: sanitized.truncated,
      omittedParts: sanitized.omittedParts,
    };
  } catch {
    return null;
  }
}

function sanitizePresentedTraceMessages(messages: unknown[]): {
  messages: unknown[];
  truncated: boolean;
  omittedParts: number | null;
} {
  const sanitized: unknown[] = [];
  let retainedParts = 0;
  const traceMarker = messages.find((message) => {
    if (!message || typeof message !== "object") return false;
    return (message as Record<string, unknown>).type === "trace_truncated";
  }) as Record<string, unknown> | undefined;
  const markerOmittedParts =
    typeof traceMarker?.omittedParts === "number" &&
    Number.isSafeInteger(traceMarker.omittedParts) &&
    traceMarker.omittedParts > 0
      ? traceMarker.omittedParts
      : null;
  const transcriptMessages = messages.filter((message) => {
    if (!message || typeof message !== "object") return true;
    return (message as Record<string, unknown>).type !== "trace_truncated";
  });
  let truncated = transcriptMessages.length > 64 || traceMarker !== undefined;
  for (const message of transcriptMessages.slice(0, 64)) {
    if (!message || typeof message !== "object") {
      truncated = true;
      continue;
    }
    const candidate = message as Record<string, unknown>;
    if (
      (candidate.role !== "user" && candidate.role !== "assistant") ||
      !Array.isArray(candidate.parts)
    ) {
      truncated = true;
      continue;
    }
    const parts: unknown[] = [];
    for (const value of candidate.parts) {
      if (retainedParts >= MAX_PRESENTED_AGENT_TRACE_PARTS) {
        truncated = true;
        break;
      }
      if (!value || typeof value !== "object") {
        truncated = true;
        continue;
      }
      const part = value as Record<string, unknown>;
      // Hidden provider reasoning is never projected. Observable text and
      // tool activity are the durable product transcript.
      if (part.kind === "thinking") continue;
      if (part.kind === "text" && typeof part.text === "string") {
        parts.push({ kind: "text", text: presentedTranscriptText(part.text) });
        retainedParts += 1;
      } else if (
        part.kind === "tool_use" &&
        typeof part.toolCallId === "string" &&
        typeof part.tool === "string"
      ) {
        parts.push({
          kind: "tool_use",
          toolCallId: part.toolCallId,
          tool: part.tool,
          args: part.args,
        });
        retainedParts += 1;
      } else if (part.kind === "tool_result" && typeof part.toolCallId === "string") {
        parts.push({
          kind: "tool_result",
          toolCallId: part.toolCallId,
          result: part.result,
        });
        retainedParts += 1;
      } else if (part.kind !== "thinking") {
        truncated = true;
      }
    }
    if (parts.length > 0) sanitized.push({ role: candidate.role, parts });
  }
  if (traceMarker !== undefined) {
    sanitized.push({ type: "trace_truncated", omittedParts: markerOmittedParts });
  }
  return { messages: sanitized, truncated, omittedParts: markerOmittedParts };
}

/**
 * One transcript text part as the exchange feed shows it. A turn that died
 * ends its last text part on `Model request failed: <code>: <message>` —
 * at the start, or after the blank line separating it from whatever the turn
 * produced first. The message may quote a provider, so it is never echoed;
 * the code alone decides whether the line reads as a failure or, for
 * `canceled`, as the stop it was.
 */
function presentedTranscriptText(text: string): string {
  let markerStart: number;
  if (text.startsWith(TERMINAL_TRANSCRIPT_MARKER)) {
    markerStart = 0;
  } else {
    const separated = text.lastIndexOf(`\n\n${TERMINAL_TRANSCRIPT_MARKER}`);
    if (separated < 0) return text;
    markerStart = separated + 2;
  }
  const code = text.slice(markerStart + TERMINAL_TRANSCRIPT_MARKER.length).split(":", 1)[0];
  const safe =
    code?.trim() === "canceled"
      ? SAFE_MODEL_STOP_TRANSCRIPT_TEXT
      : SAFE_MODEL_FAILURE_TRANSCRIPT_TEXT;
  const body = text.slice(0, markerStart).trimEnd();
  return body.length > 0 ? `${body}\n\n${safe}` : safe;
}

function recordedDraftAnswer(
  displayJson: string | null,
  payloadJson: string | null,
): string | null {
  if (!displayJson || !payloadJson) return null;
  try {
    const display = JSON.parse(displayJson) as { digest?: unknown };
    const payload = JSON.parse(payloadJson) as { candidateAnswer?: unknown };
    if (typeof display.digest !== "string" || typeof payload.candidateAnswer !== "string") {
      return null;
    }
    return sha256(payload.candidateAnswer) === display.digest ? payload.candidateAnswer : null;
  } catch {
    return null;
  }
}

function normalizeDenialReason(value: string | null): PrivacyExchangePresentation["denialReason"] {
  switch (value) {
    case "privacy_policy":
    case "hard_stop":
    case "user_denied":
    case "expired":
    case "canceled":
    case "approval_not_available":
      return value;
    default:
      return null;
  }
}

function parseFailure(
  displayJson: string | null,
  payloadJson: string | null,
  agentTracePayloadJson: string | null,
): { code: string; message: string; detail?: string } | null {
  const legacyFailure = legacyTraceFailure(agentTracePayloadJson);
  if (!displayJson || !payloadJson) return legacyFailure;
  try {
    const display = JSON.parse(displayJson) as { text?: unknown; detail?: unknown };
    const payload = JSON.parse(payloadJson) as { reason?: unknown };
    if (typeof display.text !== "string" || typeof payload.reason !== "string") return null;
    // Older rows only said "Nothing was released.". Do not echo model data;
    // use a strictly mapped, vetted terminal condition from their trace instead.
    if (
      display.text === "Nothing was released." ||
      (legacyFailure && isGenericFailure(payload.reason, display.text))
    )
      return legacyFailure;
    const detail = typeof display.detail === "string" ? display.detail.trim() : "";
    return { code: payload.reason, message: display.text, ...(detail ? { detail } : {}) };
  } catch {
    return legacyFailure;
  }
}

/**
 * Recover a terminal condition for a row whose stored failure says only that
 * something went wrong, by matching the two model-failure stubs its trace
 * carries. A row whose failure already names a code needs no reconstruction.
 */
function legacyTraceFailure(payloadJson: string | null): { code: string; message: string } | null {
  if (!payloadJson) return null;
  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (!payload || typeof payload !== "object") return null;
    const trace = payload as { terminalStopReason?: unknown; messages?: unknown };
    if (trace.terminalStopReason === "canceled") {
      return {
        code: "answer_canceled",
        message: "The request was canceled before Omnesis completed it.",
      };
    }
    if (hasEmptyLengthModelFailure(trace.messages)) {
      return {
        code: "http_empty_response",
        message:
          "The model returned an empty response (finish_reason=length) before producing a final answer.",
      };
    }
    if (hasHttpRequestFailure(trace.messages)) {
      return {
        code: "http_request_error",
        message:
          "The model request could not reach the selected model. Check that the backend is running and reachable, then try again.",
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isGenericFailure(code: string, message: string): boolean {
  return (
    (code === "answer_failed" || code === "answer_generation_or_review_failed") &&
    message === "Omnesis could not complete this answer."
  );
}

function hasHttpRequestFailure(messages: unknown): boolean {
  return hasModelFailurePrefix(messages, "Model request failed: http_request_error:");
}

function hasEmptyLengthModelFailure(messages: unknown): boolean {
  return hasModelFailurePrefix(
    messages,
    "Model request failed: http_empty_response: Model returned an empty response (finish_reason=length).",
  );
}

function hasModelFailurePrefix(messages: unknown, prefix: string): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return false;
    return parts.some(
      (part) =>
        Boolean(part) &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string" &&
        (part as { text: string }).text.startsWith(prefix),
    );
  });
}

export function recordedReleaseEgressAt(
  db: PrivacyDb,
  evidence: ReleaseEvidence | null,
): number | null {
  if (!evidence) return null;
  return recordedReleaseEgressTimes(db, [evidence]).get(evidence.taskId) ?? null;
}

export function latestPrivacyExchangeOutcomes(
  db: PrivacyDb,
  conversationIds: readonly string[],
  now = Date.now(),
): Map<string, PrivacyExchangeOutcome> {
  const uniqueConversationIds = [...new Set(conversationIds)];
  if (uniqueConversationIds.length === 0) return new Map();
  const placeholders = uniqueConversationIds.map(() => "?").join(", ");
  const rows = db
    .prepare<unknown[], LatestOutcomeRow>(
      `SELECT t.id, t.workflow_id, t.conversation_id, t.status, t.release_id,
              t.reductions_json AS response_reductions_json, r.answer AS release_answer,
              a.status AS approval_status, a.expires_at AS approval_expires_at
         FROM answer_tasks t
         LEFT JOIN answer_releases r ON r.task_id = t.id
         LEFT JOIN answer_approvals a ON a.task_id = t.id
        WHERE t.conversation_id IN (${placeholders})
          AND t.id = (
            SELECT latest.id
              FROM answer_tasks latest
             WHERE latest.conversation_id = t.conversation_id
             ORDER BY latest.created_at DESC, latest.id DESC
             LIMIT 1
          )`,
    )
    .all(...uniqueConversationIds);
  const sharedAtByTaskId = recordedReleaseEgressTimes(
    db,
    rows.map(releaseEvidence).filter((evidence) => evidence !== null),
  );
  return new Map(
    rows.map((row) => [
      row.conversation_id,
      toOutcome(
        presentedTaskStatus(
          normalizeTaskStatus(row.status),
          effectiveApprovalStatus(
            normalizeApprovalStatus(row.approval_status),
            row.approval_expires_at,
            now,
          ),
        ),
        sharedAtByTaskId.has(row.id),
      ),
    ]),
  );
}

/**
 * Renders the task state the periodic sweep will materialize: a task still
 * `approval_required` whose approval has (effectively) expired presents as the
 * expired denial the sweep writes.
 */
function presentedTaskStatus(
  status: AnswerTaskAuditStatus,
  approvalStatus: PrivacyApprovalStatus | null,
): AnswerTaskAuditStatus {
  return status === "approval_required" && approvalStatus === "expired" ? "denied" : status;
}

function recordedReleaseEgressTimes(
  db: PrivacyDb,
  evidences: readonly ReleaseEvidence[],
): Map<string, number> {
  const evidenceByTaskId = new Map(evidences.map((evidence) => [evidence.taskId, evidence]));
  if (evidenceByTaskId.size === 0) return new Map();
  const exactResponseClauses = [...evidenceByTaskId].map(
    () => "(task_id = ? AND response_digest = ?)",
  );
  const params = [...evidenceByTaskId.values()].flatMap((evidence) => [
    evidence.taskId,
    evidence.responseDigest,
  ]);
  const rows = db
    .prepare<string[], RecordedEgressRow>(
      `SELECT first.task_id, e.created_at
         FROM (
           SELECT task_id, MIN(rowid) AS first_rowid
             FROM answer_egress_events
            WHERE ${exactResponseClauses.join(" OR ")}
            GROUP BY task_id
         ) first
         JOIN answer_egress_events e ON e.rowid = first.first_rowid`,
    )
    .all(...params);
  const sharedAtByTaskId = new Map<string, number>();
  for (const row of rows) {
    sharedAtByTaskId.set(row.task_id, row.created_at);
  }
  return sharedAtByTaskId;
}

function releaseEvidence(row: ReleaseEvidenceRow): ReleaseEvidence | null {
  if (
    (row.status !== "released" && row.status !== "released_with_reductions") ||
    !row.release_id ||
    row.release_answer === null
  ) {
    return null;
  }
  const reductions = parseStringArray(row.response_reductions_json);
  const response = buildReleasedAnswerResponse({
    workflowId: row.workflow_id,
    conversationId: row.conversation_id,
    taskId: row.id,
    status: row.status,
    releaseId: row.release_id,
    answer: row.release_answer,
    reductions,
  });
  return {
    taskId: row.id,
    workflowId: row.workflow_id,
    conversationId: row.conversation_id,
    status: row.status,
    releaseId: row.release_id,
    responseDigest: sha256(JSON.stringify(response)),
  };
}

export function fallbackExternalAgentIdentity(): PrivacyExternalAgentIdentity {
  return externalAgentIdentity("External agent", "fallback");
}

/**
 * A trailing parenthesized integration slug, as agent integrations name their
 * token: `Atlas (openclaw)`.
 *
 * The slug has to be one Omnesis actually pairs with, not merely a lowercase
 * word. A caller's name is its own to choose, and `Deploybot (v2)`,
 * `Assistant (beta)` and `Quarterly Report (2024)` all end in a bare lowercase
 * token that says nothing about which integration carried the request — eating
 * it would rename the caller in every sentence the operator reads.
 */
const AGENT_SLUG_SUFFIX = /^(.*\S)\s*\(([a-z0-9][a-z0-9._-]*)\)$/;

/**
 * Split a self-asserted display name into the name a sentence should use and
 * the integration it named, deriving once here what would otherwise be three
 * client-side regexes over a string the gateway already holds.
 *
 * Conservative in both directions: a name that is only a slug keeps its
 * parentheses rather than becoming empty, and a name whose parentheses do not
 * balance is left exactly as written.
 */
export function externalAgentIdentity(
  name: unknown,
  source: PrivacyExternalAgentIdentity["source"],
): PrivacyExternalAgentIdentity {
  const displayName = typeof name === "string" && name.trim() ? name.trim() : "External agent";
  const match = AGENT_SLUG_SUFFIX.exec(displayName);
  const narrativeName = match?.[1]?.trim();
  const slug = match?.[2];
  if (!narrativeName || !slug || !isKnownHarness(slug) || !balancedParentheses(narrativeName)) {
    return { displayName, narrativeName: displayName, integrationSlug: null, source };
  }
  return { displayName, narrativeName, integrationSlug: slug, source };
}

/**
 * The identity of an integration Omnesis paired with itself, where which
 * integration it is comes from the device's declared capability rather than
 * from the name.
 *
 * The regex above exists to recover a slug a caller chose to write into its own
 * name; here the slug is already known, and reading it off the name instead
 * would make the operator's ability to see who receives a disclosure depend on
 * how a device happened to be named. The name still supplies the display and
 * narrative forms, and still gives up a trailing slug of its own so a device
 * named for its harness does not read as saying it twice.
 */
export function integrationAgentIdentity(
  name: unknown,
  harness: string,
): PrivacyExternalAgentIdentity {
  return { ...externalAgentIdentity(name, "integration"), integrationSlug: harness };
}

function balancedParentheses(value: string): boolean {
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Whether a table this reader joins for display carries the column it wants.
 *
 * The privacy store is opened over whatever database the caller hands it, and a
 * fixture that seeds only the answer tables is a legitimate one — a display
 * join is not worth a throw, so a missing column costs the generic label and
 * nothing more.
 */
/**
 * Which of several `table.column` pairs exist, in one statement: a reader that
 * needs more than one column for a namespace still probes it once.
 */
function probeColumns(db: PrivacyDb, columns: ReadonlyArray<readonly [string, string]>): boolean[] {
  const select = columns
    .map(
      ([table, column], index) =>
        `EXISTS (SELECT 1 FROM pragma_table_info('${table}') WHERE name = '${column}') AS c${index}`,
    )
    .join(", ");
  const row = db.prepare<[], Record<string, number>>(`SELECT ${select}`).get() ?? {};
  return columns.map((_, index) => row[`c${index}`] === 1);
}

function hasColumn(db: PrivacyDb, table: string, column: string): boolean {
  return Boolean(
    db
      .prepare<
        [string],
        { found: number }
      >(`SELECT 1 AS found FROM pragma_table_info('${table}') WHERE name = ?`)
      .get(column),
  );
}

function normalizeTaskStatus(status: string): AnswerTaskAuditStatus {
  switch (status) {
    case "running":
    case "approval_required":
    case "released":
    case "released_with_reductions":
    case "denied":
    case "failed":
    case "canceled":
      return status;
    default:
      return "failed";
  }
}

function normalizeApprovalStatus(status: string | null): PrivacyApprovalStatus | null {
  switch (status) {
    case "pending":
    case "approved":
    case "denied":
    case "expired":
      return status;
    default:
      return null;
  }
}

function normalizeFallbackCause(value: unknown): PrivacyReviewerFallbackCause | null {
  switch (value) {
    case "not_configured":
    case "request_failed":
    case "context_window_exceeded":
    case "output_truncated":
    case "invalid_output":
    case "low_confidence":
    case "policy_requires_review":
    case "hard_stop":
      return value;
    default:
      return null;
  }
}

function toOutcome(
  status: AnswerTaskAuditStatus,
  externallyShared: boolean,
): PrivacyExchangeOutcome {
  switch (status) {
    case "running":
      return "checking";
    case "approval_required":
      return "needs_review";
    case "released":
      return externallyShared ? "shared" : "ready";
    case "released_with_reductions":
      return externallyShared ? "shared_with_reductions" : "ready";
    case "denied":
      return "not_shared";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return assertNever(status);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): ExchangeCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { createdAt?: unknown }).createdAt !== "number" ||
      !Number.isSafeInteger((value as { createdAt: number }).createdAt) ||
      typeof (value as { id?: unknown }).id !== "string" ||
      (value as { id: string }).id.length === 0
    ) {
      throw new Error("invalid cursor");
    }
    return value as ExchangeCursor;
  } catch {
    throw new PrivacyCursorError();
  }
}
