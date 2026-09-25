// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import { assertNever } from "@omnesis/core";
import { PRIVACY_AUDIT_EVENT_KINDS } from "@omnesis/types/privacy";
import { compareReleasedAnswer } from "./answer-diff.js";
import { getOwnedTask, parseDisclosureCategories, responseForTask } from "./store-internals.js";
import {
  fallbackExternalAgentIdentity,
  latestPrivacyExchangeOutcomes,
  privacyExternalAgentIdentities,
  privacyExternalAgentIdentity,
} from "./presentation.js";
import {
  AnswerStoreError,
  PrivacyCursorError,
  type AppendAnswerAuditEventInput,
  type DeletePrivacyConversationInput,
  type PrivacyDb,
  type RecordAnswerEgressInput,
  type RecordedAnswerEgress,
} from "./store-types.js";
import type {
  PrivacyAuditEventDetail,
  PrivacyAuditEventDisplay,
  PrivacyAuditStatusCode,
  PrivacyAuditStatusDisplay,
  PrivacyAuditEventKind,
  PrivacyAuditEventPage,
  PrivacyAuditEventSummary,
  PrivacyConversationDetail,
  PrivacyConversationPage,
  PrivacyConversationSummary,
  PrivacyCumulativeCategory,
  PrivacyCumulativeDisclosure,
  PrivacyExternalAgentIdentity,
  PrivacyExternalMessage,
} from "@omnesis/types/privacy";

const MAX_AUDIT_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_AUDIT_TASK_BYTES = 16 * 1024 * 1024;
const MAX_AUDIT_CONVERSATION_BYTES = 64 * 1024 * 1024;
const MAX_AUDIT_OWNER_BYTES = 512 * 1024 * 1024;
const MAX_EXTERNAL_CONTEXT_MESSAGES = 40;

function mergeReviewerDisclosureCategories(
  answerCategories: PrivacyCumulativeCategory[],
  watchCategories: PrivacyCumulativeCategory[],
): PrivacyCumulativeCategory[] {
  const merged = new Map<string, PrivacyCumulativeCategory>();
  for (const item of answerCategories) {
    merged.set(`${item.category}\0${item.detailLevel}\0${item.subject}`, { ...item });
  }
  for (const category of watchCategories) {
    const key = `${category.category}\0${category.detailLevel}\0${category.subject}`;
    const prior = merged.get(key);
    if (prior) prior.count += category.count;
    else merged.set(key, { ...category });
  }
  return [...merged.values()].sort(
    (left, right) => right.count - left.count || left.category.localeCompare(right.category),
  );
}

function parseWatchDisclosureCategories(
  value: string,
  existenceSignals: number,
): PrivacyCumulativeCategory[] {
  const structured = parseDisclosureCategories(value);
  if (structured.length > 0) return structured;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((category): PrivacyCumulativeCategory[] =>
      typeof category === "string" && existenceSignals > 0
        ? [
            {
              category,
              detailLevel: "existence",
              subject: "unknown",
              count: existenceSignals,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}
/** Protocol states yield at most two responses; retain headroom without unbounded variants. */
export const MAX_DISTINCT_ANSWER_EGRESS_RESPONSES_PER_TASK = 8;

interface AuditEventRow {
  sequence: number;
  id: string;
  task_id: string;
  event_type: string;
  display_json: string;
  payload_id: string | null;
  payload_digest: string | null;
  payload_bytes: number;
  original_payload_bytes: number;
  payload_truncated: number;
  created_at: number;
}

interface ConversationRow {
  id: string;
  workflow_id: string;
  owner_id: string;
  workflow_name: string;
  workflow_purpose: string;
  workflow_status: "active" | "closed" | "expired";
  workflow_expires_at: number;
  title: string;
  created_at: number;
  updated_at: number;
  task_count: number;
  latest_status: string;
  pending_approval_count: number;
}

export function appendAnswerAuditEvents(
  db: PrivacyDb,
  inputs: ReadonlyArray<AppendAnswerAuditEventInput>,
): void {
  if (inputs.length === 0) return;
  db.transaction(() => {
    for (const input of inputs) appendAnswerAuditEvent(db, input);
  })();
}

export function appendAnswerAuditEvent(db: PrivacyDb, input: AppendAnswerAuditEventInput): void {
  const task = getOwnedTask(db, input.taskId, input.ownerId);
  const encoded = input.payload === undefined ? null : encodePayload(db, task, input.payload);
  const payloadId = encoded ? `payload_${input.id}` : null;
  db.prepare(
    `INSERT INTO answer_audit_events (
       id, conversation_id, task_id, owner_id, event_type, display_json,
       payload_id, payload_digest, payload_bytes, original_payload_bytes,
       payload_truncated, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    task.conversation_id,
    task.id,
    task.owner_id,
    input.kind,
    JSON.stringify(input.display),
    payloadId,
    encoded?.digest ?? null,
    encoded?.retainedBytes ?? 0,
    encoded?.originalBytes ?? 0,
    encoded?.truncated ? 1 : 0,
    input.now,
  );
  if (encoded && payloadId) {
    db.prepare(
      "INSERT INTO answer_audit_payloads (id, event_id, payload_json) VALUES (?, ?, ?)",
    ).run(payloadId, input.id, encoded.json);
  }
  db.prepare("UPDATE answer_conversations SET updated_at = ? WHERE id = ?").run(
    input.now,
    task.conversation_id,
  );
}

export function recordAnswerEgress(
  db: PrivacyDb,
  input: RecordAnswerEgressInput,
  recordMcpAudit?: (
    db: PrivacyDb,
    input: NonNullable<RecordAnswerEgressInput["mcpInvocationAudit"]>,
  ) => boolean,
  currentDeviceAnswerOwner?: (db: PrivacyDb, deviceId: string, tokenId: string) => string | null,
): RecordedAnswerEgress | null {
  return db.transaction(() => {
    const task = getOwnedTask(db, input.taskId, input.ownerId);
    const response = responseForTask(db, task.id);
    if (!response) return null;
    // Answer egress and the final MCP authority check are one commit. Validate
    // only after a releasable response exists: a pending status poll must not
    // create a successful invocation audit. Repeated reads of the same answer
    // still validate authority and receive their own invocation attribution,
    // even though the canonical disclosure payload is deduplicated below.
    if (input.mcpInvocationAudit) {
      // The authority helper obtains its own clock value here, on the writer,
      // rather than trusting the request timestamp captured before the write
      // entered the queue. A token, credential, or grant that expires while
      // waiting must fence the Answer before its egress row can commit.
      if (!recordMcpAudit || !recordMcpAudit(db, input.mcpInvocationAudit)) {
        throw new Error("MCP authority changed before Answer egress.");
      }
    }
    // The same fence for a device token: its access level is read again here,
    // on the writer, so a level narrowed or removed while the answer was being
    // made keeps that answer from leaving.
    if (input.deviceAnswerAuthority) {
      const { deviceId, tokenId } = input.deviceAnswerAuthority;
      if (
        !currentDeviceAnswerOwner ||
        currentDeviceAnswerOwner(db, deviceId, tokenId) !== input.ownerId
      ) {
        throw new AnswerStoreError(
          "authority_changed",
          "This device's access changed while the answer was being made; ask again.",
        );
      }
    }
    const responseJson = JSON.stringify(response);
    const digest = sha256(responseJson);
    const alreadyRecorded = db
      .prepare<
        [string, string],
        { found: number }
      >("SELECT 1 AS found FROM answer_egress_events WHERE task_id = ? AND response_digest = ?")
      .get(task.id, digest);
    if (alreadyRecorded) return { response, responseJson };

    // Only the first occurrence of each exact canonical Answer response is
    // retained. HTTP returns these bytes directly; MCP carries the same object
    // as structured content inside its protocol envelope. Repeated retrieval
    // does not amplify the durable ledger.
    const distinctResponseCount =
      db
        .prepare<
          [string],
          { count: number }
        >("SELECT COUNT(DISTINCT response_digest) AS count FROM answer_egress_events WHERE task_id = ?")
        .get(task.id)?.count ?? 0;
    if (distinctResponseCount >= MAX_DISTINCT_ANSWER_EGRESS_RESPONSES_PER_TASK) {
      throw new AnswerStoreError(
        "egress_limit",
        "The distinct answer response limit has been reached for this task.",
      );
    }
    db.prepare(
      `INSERT OR IGNORE INTO answer_egress_payloads (digest, response_json, response_bytes)
       VALUES (?, ?, ?)`,
    ).run(digest, responseJson, Buffer.byteLength(responseJson, "utf8"));
    db.prepare(
      `INSERT INTO answer_egress_events (
         id, task_id, conversation_id, owner_id, endpoint, http_status,
         response_digest, subscription_firing_id, created_at
       ) VALUES (?, ?, ?, ?, ?, 200, ?, ?, ?)`,
    ).run(
      input.id,
      task.id,
      task.conversation_id,
      task.owner_id,
      input.endpoint,
      digest,
      input.subscriptionFiringId ?? null,
      input.now,
    );
    appendAnswerAuditEvent(db, {
      id: `audit_${input.id}`,
      taskId: task.id,
      ownerId: task.owner_id,
      kind: "egress",
      display: auditDisplay({
        title: "Outbound response",
        status: response.status,
        text: "The first occurrence of this canonical Answer response was disclosed to the external agent.",
        digest,
        releaseId: "releaseId" in response ? response.releaseId : null,
      }),
      payload: {
        endpoint: input.endpoint,
        httpStatus: 200,
        responseDigest: digest,
      },
      now: input.now,
    });
    return { response, responseJson };
  })();
}

export function listPrivacyConversations(
  db: PrivacyDb,
  limit = 50,
  cursor?: string,
  now = Date.now(),
): PrivacyConversationPage {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const after = cursor ? decodeConversationCursor(cursor) : null;
  const rows = db
    .prepare<unknown[], ConversationRow>(
      `${conversationProjectionSql()}
       ${after ? "WHERE (c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))" : ""}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT ?`,
    )
    .all(
      ...(after
        ? [now, now, after.updatedAt, after.updatedAt, after.id, safeLimit + 1]
        : [now, now, safeLimit + 1]),
    );
  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit);
  const last = page.at(-1);
  const latestOutcomes = latestPrivacyExchangeOutcomes(
    db,
    page.map((row) => row.id),
    now,
  );
  const identities = privacyExternalAgentIdentities(
    db,
    page.map((row) => row.owner_id),
  );
  return {
    conversations: page.map((row) =>
      toConversationSummary(
        row,
        latestOutcomes.get(row.id) ?? "failed",
        identities.get(row.owner_id) ?? fallbackExternalAgentIdentity(),
      ),
    ),
    nextCursor: hasMore && last ? encodeConversationCursor(last.updated_at, last.id) : null,
  };
}

export function getPrivacyConversation(
  db: PrivacyDb,
  conversationId: string,
  now = Date.now(),
): PrivacyConversationDetail | null {
  const row = db
    .prepare<
      [number, number, string],
      ConversationRow
    >(`${conversationProjectionSql()} WHERE c.id = ?`)
    .get(now, now, conversationId);
  if (!row) return null;
  const latestOutcome = latestPrivacyExchangeOutcomes(db, [row.id], now).get(row.id) ?? "failed";
  return {
    ...toConversationSummary(row, latestOutcome, privacyExternalAgentIdentity(db, row.owner_id)),
    workflowStatus: row.workflow_status,
    workflowExpiresAt: row.workflow_expires_at,
  };
}

function privacyConversationExists(db: PrivacyDb, conversationId: string): boolean {
  return (
    db
      .prepare<
        [string],
        { found: number }
      >("SELECT 1 AS found FROM answer_conversations WHERE id = ?")
      .get(conversationId) !== undefined
  );
}

export function listPrivacyAuditEvents(
  db: PrivacyDb,
  conversationId: string,
  limit = 50,
  cursor?: string,
): PrivacyAuditEventPage | null {
  if (!privacyConversationExists(db, conversationId)) return null;
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const before = cursor ? decodeEventCursor(cursor) : null;
  const rows = db
    .prepare<unknown[], AuditEventRow>(
      `SELECT sequence, id, task_id, event_type, display_json, payload_id,
              payload_digest, payload_bytes, original_payload_bytes,
              payload_truncated, created_at
         FROM answer_audit_events
        WHERE conversation_id = ? ${before === null ? "" : "AND sequence < ?"}
        ORDER BY sequence DESC
        LIMIT ?`,
    )
    .all(
      ...(before === null
        ? [conversationId, safeLimit + 1]
        : [conversationId, before, safeLimit + 1]),
    );
  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit);
  const earliest = page.at(-1);
  return {
    events: projectAuditEvents(db, page.reverse()),
    previousCursor: hasMore && earliest ? encodeEventCursor(earliest.sequence) : null,
  };
}

export function getPrivacyAuditEvent(
  db: PrivacyDb,
  conversationId: string,
  eventId: string,
): PrivacyAuditEventDetail | null {
  const row = db
    .prepare<[string, string], AuditEventRow>(
      `SELECT sequence, id, task_id, event_type, display_json, payload_id,
              payload_digest, payload_bytes, original_payload_bytes,
              payload_truncated, created_at
         FROM answer_audit_events
        WHERE conversation_id = ? AND id = ?`,
    )
    .get(conversationId, eventId);
  if (!row) return null;
  const payloadRow = row.payload_id
    ? db
        .prepare<
          [string],
          { payload_json: string }
        >("SELECT payload_json FROM answer_audit_payloads WHERE id = ?")
        .get(row.payload_id)
    : null;
  const summary = projectAuditEvents(db, [row])[0];
  let payload = payloadRow ? parseUnknownJson(payloadRow.payload_json) : null;
  if (row.event_type === "egress") {
    const payloadDigest = isRecord(payload) ? payload.responseDigest : null;
    const digest = typeof payloadDigest === "string" ? payloadDigest : summary.display.digest;
    if (digest) {
      const egressPayload = db
        .prepare<
          [string],
          { response_json: string }
        >("SELECT response_json FROM answer_egress_payloads WHERE digest = ?")
        .get(digest);
      if (egressPayload) {
        payload = {
          ...(isRecord(payload) ? payload : {}),
          exactResponseJson: egressPayload.response_json,
        };
      }
    }
  }
  return {
    ...summary,
    payload,
  };
}

export function loadPrivacyReviewerContext(
  db: PrivacyDb,
  workflowId: string,
  conversationId: string,
  ownerId: string,
): {
  priorExternalConversation: PrivacyExternalMessage[];
  cumulativeDisclosure: PrivacyCumulativeDisclosure;
} {
  const conversation = db
    .prepare<
      [string],
      { owner_id: string }
    >("SELECT owner_id FROM answer_conversations WHERE id = ?")
    .get(conversationId);
  if (!conversation) {
    throw new AnswerStoreError("conversation_not_found", "Answer conversation not found.");
  }
  if (conversation.owner_id !== ownerId) {
    throw new AnswerStoreError("owner_mismatch", "Answer conversation belongs to another caller.");
  }
  const priorExternalConversation = db
    .prepare<[string, number], { role: "user" | "assistant"; content: string }>(
      `SELECT role, content FROM (
         SELECT id, role, content FROM answer_messages
          WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(conversationId, MAX_EXTERNAL_CONTEXT_MESSAGES);
  const totalMessages =
    db
      .prepare<
        [string],
        { count: number }
      >("SELECT COUNT(*) AS count FROM answer_messages WHERE conversation_id = ?")
      .get(conversationId)?.count ?? priorExternalConversation.length;
  const cumulativeDisclosure = loadWorkflowCumulativeDisclosure(db, workflowId);
  return {
    priorExternalConversation,
    cumulativeDisclosure: {
      ...cumulativeDisclosure,
      olderTurnsOmitted: Math.floor(
        Math.max(0, totalMessages - priorExternalConversation.length) / 2,
      ),
    },
  };
}

/** Workflow disclosure context without requiring an Answer conversation. */
export function loadWorkflowCumulativeDisclosure(
  db: PrivacyDb,
  workflowId: string,
): PrivacyCumulativeDisclosure {
  const disclosure = db
    .prepare<
      [string],
      {
        revision: number;
        released_turns: number;
        released_characters: number;
        categories_json: string;
      }
    >(
      `SELECT revision, released_turns, released_characters, categories_json
         FROM answer_workflow_disclosure WHERE workflow_id = ?`,
    )
    .get(workflowId) ?? {
    revision: 0,
    released_turns: 0,
    released_characters: 0,
    categories_json: "[]",
  };
  let watchDisclosure = { revision: 0, existence_signals: 0, categories_json: "[]" };
  try {
    watchDisclosure =
      db
        .prepare<
          [string],
          { revision: number; existence_signals: number; categories_json: string }
        >(
          `SELECT revision, existence_signals, categories_json
             FROM subscription_workflow_disclosure WHERE workflow_id = ?`,
        )
        .get(workflowId) ?? watchDisclosure;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("no such table")) throw error;
  }
  return {
    revision: disclosure.revision,
    existenceRevision: watchDisclosure.revision,
    existenceSignals: watchDisclosure.existence_signals,
    releasedTurns: disclosure.released_turns,
    releasedCharacters: disclosure.released_characters,
    olderTurnsOmitted: 0,
    categories: mergeReviewerDisclosureCategories(
      parseDisclosureCategories(disclosure.categories_json),
      parseWatchDisclosureCategories(
        watchDisclosure.categories_json,
        watchDisclosure.existence_signals,
      ),
    ),
  };
}

export function deletePrivacyConversation(
  db: PrivacyDb,
  input: DeletePrivacyConversationInput,
): boolean {
  return db.transaction(() => {
    const conversation = db
      .prepare<
        [string],
        { owner_id: string }
      >("SELECT owner_id FROM answer_conversations WHERE id = ?")
      .get(input.conversationId);
    if (!conversation) return false;
    const running = db
      .prepare<
        [string],
        { count: number }
      >("SELECT COUNT(*) AS count FROM answer_tasks WHERE conversation_id = ? AND status = 'running'")
      .get(input.conversationId)?.count;
    if (running) {
      throw new AnswerStoreError(
        "conversation_running",
        "A privacy conversation cannot be deleted while an answer is running.",
      );
    }
    const releases = db
      .prepare<[string], { answer: string }>(
        `SELECT r.answer FROM answer_releases r
         JOIN answer_tasks t ON t.id = r.task_id
         WHERE t.conversation_id = ?`,
      )
      .all(input.conversationId);
    const requests = db
      .prepare<
        [string],
        { owner_id: string; client_request_id: string; request_fingerprint: string }
      >(
        `SELECT owner_id, client_request_id, request_fingerprint
           FROM answer_tasks WHERE conversation_id = ?`,
      )
      .all(input.conversationId);
    const egress = db
      .prepare<[string], { count: number; last_at: number | null }>(
        `SELECT COUNT(*) AS count, MAX(created_at) AS last_at
           FROM answer_egress_events WHERE conversation_id = ?`,
      )
      .get(input.conversationId) ?? { count: 0, last_at: null };
    db.prepare(
      `INSERT OR REPLACE INTO answer_conversation_tombstones (
         id, owner_id, deleted_at, egress_count, last_egress_at, release_digests_json
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.conversationId,
      conversation.owner_id,
      input.now,
      egress.count,
      egress.last_at,
      JSON.stringify(releases.map((release) => sha256(release.answer))),
    );
    const insertRequestTombstone = db.prepare(
      `INSERT OR REPLACE INTO answer_request_tombstones
         (owner_id, client_request_id, request_fingerprint, deleted_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const request of requests) {
      insertRequestTombstone.run(
        request.owner_id,
        request.client_request_id,
        request.request_fingerprint,
        input.now,
      );
    }
    // See #58 — a workflow orphaned by this delete is never garbage-collected.
    db.prepare("DELETE FROM answer_conversations WHERE id = ?").run(input.conversationId);
    db.prepare(
      `DELETE FROM answer_egress_payloads
        WHERE NOT EXISTS (
          SELECT 1 FROM answer_egress_events e
           WHERE e.response_digest = answer_egress_payloads.digest
        )`,
    ).run();
    return true;
  })();
}

function encodePayload(
  db: PrivacyDb,
  task: { id: string; conversation_id: string; owner_id: string },
  payload: unknown,
): {
  json: string;
  digest: string;
  originalBytes: number;
  retainedBytes: number;
  truncated: boolean;
} {
  const raw = JSON.stringify(payload);
  if (raw === undefined) throw new TypeError("Privacy audit payload must be JSON serializable.");
  const digest = sha256(raw);
  const originalBytes = Buffer.byteLength(raw, "utf8");
  const used = auditBytesUsed(db, task);
  const reason =
    originalBytes > MAX_AUDIT_EVENT_BYTES
      ? "event_limit"
      : used.task + originalBytes > MAX_AUDIT_TASK_BYTES
        ? "task_limit"
        : used.conversation + originalBytes > MAX_AUDIT_CONVERSATION_BYTES
          ? "conversation_limit"
          : used.owner + originalBytes > MAX_AUDIT_OWNER_BYTES
            ? "owner_limit"
            : null;
  if (!reason) {
    return { json: raw, digest, originalBytes, retainedBytes: originalBytes, truncated: false };
  }
  const sentinel = JSON.stringify({
    truncated: true,
    reason,
    originalBytes,
    sha256: digest,
  });
  return {
    json: sentinel,
    digest,
    originalBytes,
    retainedBytes: Buffer.byteLength(sentinel, "utf8"),
    truncated: true,
  };
}

function auditBytesUsed(
  db: PrivacyDb,
  task: { id: string; conversation_id: string; owner_id: string },
): { task: number; conversation: number; owner: number } {
  const sum = (where: string, value: string): number =>
    db
      .prepare<
        [string],
        { bytes: number }
      >(`SELECT COALESCE(SUM(payload_bytes), 0) AS bytes FROM answer_audit_events WHERE ${where} = ?`)
      .get(value)?.bytes ?? 0;
  return {
    task: sum("task_id", task.id),
    conversation: sum("conversation_id", task.conversation_id),
    owner: sum("owner_id", task.owner_id),
  };
}

/**
 * Binds two leading `?`s (both the current time) so a lapsed-but-unswept
 * pending approval reads as the state the sweep will materialize:
 * `latest_status` renders the expired denial and `pending_approval_count`
 * excludes it. The CASE only tests `status = 'pending'` because the sweep
 * flips the approval and its task in one transaction — an `approval_required`
 * task with a physically-`expired` approval cannot exist.
 */
function conversationProjectionSql(): string {
  return `SELECT c.id,
                 c.workflow_id,
                 c.owner_id,
                 w.name AS workflow_name,
                 w.purpose AS workflow_purpose,
                 w.status AS workflow_status,
                 w.expires_at AS workflow_expires_at,
                 COALESCE((
                   SELECT t0.question FROM answer_tasks t0
                    WHERE t0.conversation_id = c.id
                    ORDER BY t0.created_at ASC, t0.id ASC LIMIT 1
                 ), 'External answer conversation') AS title,
                 c.created_at,
                 c.updated_at,
                 (SELECT COUNT(*) FROM answer_tasks tc WHERE tc.conversation_id = c.id) AS task_count,
                 COALESCE((
                   SELECT CASE
                            WHEN tl.status = 'approval_required' AND EXISTS (
                              SELECT 1 FROM answer_approvals al
                               WHERE al.task_id = tl.id
                                 AND al.status = 'pending' AND al.expires_at <= ?
                            )
                            THEN 'denied'
                            ELSE tl.status
                          END
                     FROM answer_tasks tl
                    WHERE tl.conversation_id = c.id
                    ORDER BY tl.created_at DESC, tl.id DESC LIMIT 1
                 ), 'failed') AS latest_status,
                 (SELECT COUNT(*) FROM answer_tasks tp
                   JOIN answer_approvals ap ON ap.task_id = tp.id
                   WHERE tp.conversation_id = c.id AND tp.status = 'approval_required'
                     AND ap.status = 'pending' AND ap.expires_at > ?
                 ) AS pending_approval_count
            FROM answer_conversations c
            JOIN answer_workflows w ON w.id = c.workflow_id`;
}

function toConversationSummary(
  row: ConversationRow,
  latestOutcome: PrivacyConversationSummary["latestOutcome"],
  externalAgent: PrivacyExternalAgentIdentity,
): PrivacyConversationSummary {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    workflowPurpose: row.workflow_purpose,
    externalAgent,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    taskCount: row.task_count,
    latestStatus: normalizeTaskStatus(row.latest_status),
    latestOutcome,
    pendingApprovalCount: row.pending_approval_count,
  };
}

function normalizeTaskStatus(status: string): PrivacyConversationSummary["latestStatus"] {
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

function toAuditEventSummary(row: AuditEventRow): PrivacyAuditEventSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: normalizeEventKind(row.event_type),
    createdAt: row.created_at,
    display: parseDisplay(row.display_json),
    answerComparison: null,
    payloadAvailable: row.payload_id !== null,
    payloadDigest: row.payload_digest,
    payloadBytes: row.payload_bytes,
    originalPayloadBytes: row.original_payload_bytes,
    payloadTruncated: row.payload_truncated === 1,
  };
}

/**
 * Project stored rows onto the wire, relating every release to the candidate it
 * came from.
 *
 * A release that carries the candidate's bytes loses its own body text: the
 * record already printed those bytes one step earlier, and reprinting them
 * makes the reader compare two long identical blocks to learn that nothing
 * happened. Sameness is decided on the recorded digests rather than on the
 * displayed text, because the display is a bounded preview — two answers that
 * differ only past the preview would compare as equal — and because the digests
 * are on rows written long before this projection existed.
 *
 * A release that reduced the candidate instead gains a structured comparison,
 * computed here from the two full recorded strings so that the three clients
 * render evidence rather than each deriving their own.
 */
function projectAuditEvents(db: PrivacyDb, rows: AuditEventRow[]): PrivacyAuditEventSummary[] {
  const summaries = rows.map(toAuditEventSummary);
  personalizeEgressDisplays(db, rows, summaries);
  const releases = summaries.flatMap((summary, index) =>
    summary.kind === "released" ? [{ summary, row: rows[index] }] : [],
  );
  if (releases.length === 0) return summaries;

  const candidates = candidateRowsByTask(
    db,
    releases.map((release) => release.row.task_id),
  );
  for (const { summary, row } of releases) {
    const candidate = candidates
      .get(row.task_id)
      ?.filter((event) => event.sequence < row.sequence)
      .at(-1);
    const candidateDigest = candidate ? parseDisplay(candidate.display_json).digest : null;
    const releasedDigest = summary.display.digest;
    if (!candidate || !candidateDigest || !releasedDigest) continue;
    if (candidateDigest === releasedDigest) {
      summary.answerComparison = { kind: "identical" };
      summary.display = { ...summary.display, text: null };
      continue;
    }
    if (!isReducedRelease(summary.display)) continue;
    const candidateAnswer = recordedAnswer(db, candidate.payload_id, "candidateAnswer");
    const releasedAnswer = recordedAnswer(db, row.payload_id, "answer");
    if (candidateAnswer === null || releasedAnswer === null) continue;
    // A payload that no longer hashes to the digest its step published is not
    // evidence, and a comparison drawn from it would be a claim about text the
    // record cannot vouch for.
    if (sha256(candidateAnswer) !== candidateDigest) continue;
    if (sha256(releasedAnswer) !== releasedDigest) continue;
    summary.answerComparison = compareReleasedAnswer(candidateAnswer, releasedAnswer);
  }
  return summaries;
}

interface AuditTaskOwnerRow {
  id: string;
  owner_id: string;
}

/** Present the stored egress fact using the owner-approved recipient identity. */
function personalizeEgressDisplays(
  db: PrivacyDb,
  rows: readonly AuditEventRow[],
  summaries: PrivacyAuditEventSummary[],
): void {
  const egressTaskIds = [
    ...new Set(rows.filter((row) => row.event_type === "egress").map((row) => row.task_id)),
  ];
  if (egressTaskIds.length === 0) return;
  const owners = db
    .prepare<string[], AuditTaskOwnerRow>(
      `SELECT id, owner_id FROM answer_tasks
        WHERE id IN (${egressTaskIds.map(() => "?").join(", ")})`,
    )
    .all(...egressTaskIds);
  const ownerIdByTask = new Map(owners.map((row) => [row.id, row.owner_id]));
  const identities = privacyExternalAgentIdentities(
    db,
    owners.map((row) => row.owner_id),
  );
  for (const [index, row] of rows.entries()) {
    if (row.event_type !== "egress") continue;
    const ownerId = ownerIdByTask.get(row.task_id);
    const identity = ownerId ? identities.get(ownerId) : null;
    const name = identity?.narrativeName.trim() || "External agent";
    const recipient = name === "External agent" ? "the external agent" : name;
    summaries[index]!.display = {
      ...summaries[index]!.display,
      text: `The first occurrence of this canonical Answer response was disclosed to ${recipient}.`,
    };
  }
}

interface CandidateEventRow {
  task_id: string;
  sequence: number;
  display_json: string;
  payload_id: string | null;
}

/** Every candidate step of the given tasks, oldest first within each task. */
function candidateRowsByTask(
  db: PrivacyDb,
  taskIds: readonly string[],
): Map<string, CandidateEventRow[]> {
  const distinct = [...new Set(taskIds)];
  const rows = db
    .prepare<string[], CandidateEventRow>(
      `SELECT task_id, sequence, display_json, payload_id
         FROM answer_audit_events
        WHERE event_type = 'candidate_generated'
          AND task_id IN (${distinct.map(() => "?").join(", ")})
        ORDER BY sequence ASC`,
    )
    .all(...distinct);
  const byTask = new Map<string, CandidateEventRow[]>();
  for (const row of rows) {
    const existing = byTask.get(row.task_id);
    if (existing) existing.push(row);
    else byTask.set(row.task_id, [row]);
  }
  return byTask;
}

/**
 * A release is reduced when the reviewer struck something from the candidate.
 * The reductions it listed and the status it earned are recorded separately, and
 * either one alone is enough to say so.
 */
function isReducedRelease(display: PrivacyAuditEventDisplay): boolean {
  return display.status?.code === "reduced" || display.reductions.length > 0;
}

/** One answer string out of a trusted payload, or null when it is not there. */
function recordedAnswer(db: PrivacyDb, payloadId: string | null, field: string): string | null {
  if (!payloadId) return null;
  const row = db
    .prepare<
      [string],
      { payload_json: string }
    >("SELECT payload_json FROM answer_audit_payloads WHERE id = ?")
    .get(payloadId);
  if (!row) return null;
  const payload = parseUnknownJson(row.payload_json);
  if (!isRecord(payload)) return null;
  const value = payload[field];
  return typeof value === "string" ? value : null;
}

function normalizeEventKind(kind: string): PrivacyAuditEventKind | "unknown" {
  return (PRIVACY_AUDIT_EVENT_KINDS as readonly string[]).includes(kind)
    ? (kind as PrivacyAuditEventKind)
    : "unknown";
}

function parseDisplay(value: string): PrivacyAuditEventDisplay {
  const parsed = parseUnknownJson(value);
  if (!parsed || typeof parsed !== "object") return auditDisplay({ title: "Audit event" });
  const row = parsed as Partial<PrivacyAuditEventDisplay>;
  return auditDisplay({
    title: typeof row.title === "string" ? row.title : "Audit event",
    text: typeof row.text === "string" ? row.text : null,
    detail: typeof row.detail === "string" ? row.detail : null,
    status: persistedAuditStatus(row.status),
    provider: typeof row.provider === "string" ? row.provider : null,
    model: typeof row.model === "string" ? row.model : null,
    confidence: typeof row.confidence === "number" ? row.confidence : null,
    approvalId: typeof row.approvalId === "string" ? row.approvalId : null,
    releaseId: typeof row.releaseId === "string" ? row.releaseId : null,
    digest: typeof row.digest === "string" ? row.digest : null,
    reductions: Array.isArray(row.reductions)
      ? row.reductions.filter((item): item is string => typeof item === "string")
      : [],
  });
}

const PRIVACY_AUDIT_STATUS_LABELS: Record<PrivacyAuditStatusCode, string> = {
  allowed: "Allowed",
  reduced: "Details removed",
  held: "Held for review",
  blocked: "Blocked",
};

/**
 * Every status token a producer writes onto an audit row: the reviewer's four
 * decisions, the terminal task statuses, the reduction stage's own token, and
 * the three ways an approval resolves. Listing them here is what lets the
 * mapping below be exhaustive — a producer inventing a token the display cannot
 * place is a type error at its call site, not a silently blank chip in the one
 * column that says what left the machine.
 */
const PRIVACY_AUDIT_PRODUCER_STATUSES = [
  "allow",
  "reduce",
  "ask",
  "deny",
  "running",
  "released",
  "released_with_reductions",
  "reduced",
  "approval_required",
  "denied",
  "failed",
  "approved",
  "expired",
] as const;

export type PrivacyAuditProducerStatus = (typeof PRIVACY_AUDIT_PRODUCER_STATUSES)[number];

/**
 * Map a producer token onto the closed set a client may render, or onto null
 * when the row has no outcome to show.
 */
function auditStatusCode(status: PrivacyAuditProducerStatus): PrivacyAuditStatusCode | null {
  switch (status) {
    // `approved` is here because an approved answer is released: its row
    // reports the release, not the tap that allowed it.
    case "allow":
    case "released":
    case "approved":
      return "allowed";
    case "reduce":
    case "reduced":
    case "released_with_reductions":
      return "reduced";
    // The reviewer's `ask` is an unresolved decision: it becomes an approval
    // the operator must answer.
    case "ask":
    case "approval_required":
      return "held";
    // `expired` is a lapsed approval, which releases nothing.
    case "deny":
    case "denied":
    case "expired":
      return "blocked";
    // A request still in flight has no outcome yet, and a request that broke
    // has no outcome at all: nothing was decided about the answer, so there is
    // nothing to badge. `blocked` would read as a privacy refusal and claim a
    // decision Omnesis never made. The row's title and its failure reason carry
    // these two states instead.
    case "running":
    case "failed":
      return null;
    default:
      return assertNever(status);
  }
}

function statusDisplay(code: PrivacyAuditStatusCode): PrivacyAuditStatusDisplay {
  return { code, label: PRIVACY_AUDIT_STATUS_LABELS[code] };
}

/**
 * Read the status persisted on a row. A row written by this gateway holds the
 * already-mapped display; rows written by earlier ones hold the producer's raw
 * token, or a code, or a model stop reason such as `stop`. Anything unplaceable
 * resolves to null and simply does not render, rather than surfacing as a
 * status-shaped chip.
 */
function persistedAuditStatus(value: unknown): PrivacyAuditStatusDisplay | null {
  const code =
    value && typeof value === "object" ? (value as { code?: unknown }).code : (value as unknown);
  if (typeof code !== "string") return null;
  if (code in PRIVACY_AUDIT_STATUS_LABELS) {
    return statusDisplay(code as PrivacyAuditStatusCode);
  }
  return isProducerStatus(code) ? mapProducerStatus(code) : null;
}

function isProducerStatus(value: string): value is PrivacyAuditProducerStatus {
  return (PRIVACY_AUDIT_PRODUCER_STATUSES as readonly string[]).includes(value);
}

function mapProducerStatus(status: PrivacyAuditProducerStatus): PrivacyAuditStatusDisplay | null {
  const code = auditStatusCode(status);
  return code ? statusDisplay(code) : null;
}

export function auditDisplay(
  input: Omit<Partial<PrivacyAuditEventDisplay>, "status"> &
    Pick<PrivacyAuditEventDisplay, "title"> & {
      /** A producer token (`allow`, `ask`, …) or an already-mapped status. */
      status?: PrivacyAuditProducerStatus | PrivacyAuditStatusDisplay | null;
    },
): PrivacyAuditEventDisplay {
  const status = input.status;
  return {
    title: input.title,
    text: input.text ?? null,
    detail: input.detail ?? null,
    status: typeof status === "string" ? mapProducerStatus(status) : (status ?? null),
    provider: input.provider ?? null,
    model: input.model ?? null,
    confidence: input.confidence ?? null,
    approvalId: input.approvalId ?? null,
    releaseId: input.releaseId ?? null,
    digest: input.digest ?? null,
    reductions: input.reductions ?? [],
  };
}

function parseUnknownJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeConversationCursor(updatedAt: number, id: string): string {
  return Buffer.from(JSON.stringify([updatedAt, id]), "utf8").toString("base64url");
}

function decodeConversationCursor(cursor: string): { updatedAt: number; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "number" ||
      !Number.isSafeInteger(parsed[0]) ||
      typeof parsed[1] !== "string" ||
      parsed[1].length === 0
    ) {
      throw new PrivacyCursorError();
    }
    return { updatedAt: parsed[0], id: parsed[1] };
  } catch (err) {
    if (err instanceof PrivacyCursorError) throw err;
    throw new PrivacyCursorError();
  }
}

function encodeEventCursor(sequence: number): string {
  return Buffer.from(String(sequence), "utf8").toString("base64url");
}

function decodeEventCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sequence = Number(decoded);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || String(sequence) !== decoded) {
    throw new PrivacyCursorError();
  }
  return sequence;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
