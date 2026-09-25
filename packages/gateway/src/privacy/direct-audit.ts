// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Transcript store for the Direct MCP boundary. Same mechanics as the
 * Answer audit (bounded payloads with truncation sentinels, display/payload
 * split) in separate tables with separate budgets — see
 * `createDirectAuditTables` in `store-schema.ts`. Session assignment is
 * write-time: an explicit caller grouping key wins, otherwise the latest
 * session for the principal+credential is reused while idle gaps stay under
 * {@link DIRECT_HEURISTIC_SESSION_GAP_MS}.
 */

import { createHash, randomUUID } from "node:crypto";

import { boundDirectAuditValue } from "../agent/direct-mcp.js";
import { auditDisplay } from "./store-audit.js";
import { DIRECT_HEURISTIC_SESSION_GAP_MS, directSessionKeys } from "./direct-session.js";
import type { PrivacyDb } from "./store-types.js";
import type { McpInvocationAuditOutcome } from "../access/types.js";

const MAX_DIRECT_AUDIT_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_DIRECT_AUDIT_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_DIRECT_AUDIT_OWNER_BYTES = 512 * 1024 * 1024;

export interface AppendDirectAuditEventInput {
  ownerId: string;
  principalId: string;
  credentialId: string;
  grantId: string;
  conversationId?: string;
  workflowId?: string;
  tool: string;
  outcome: McpInvocationAuditOutcome;
  requestId: string;
  args: unknown;
  /** Corpus result; undefined when nothing was read (refused/failed calls). */
  result?: unknown;
  now: number;
}

export interface DirectAuditSession {
  id: string;
  ownerId: string;
  principalId: string;
  /** Operator-approved display name, null when the principal row is gone. */
  principalName: string | null;
  credentialId: string;
  grantId: string;
  explicitKey: string | null;
  heuristicKey: string;
  createdAt: number;
  lastEventAt: number;
  eventCount: number;
  bytesTotal: number;
}

export interface DirectAuditEvent {
  sequence: number;
  id: string;
  sessionId: string;
  tool: string;
  outcome: McpInvocationAuditOutcome;
  requestId: string;
  display: { title: string; text: string | null };
  payloadTruncated: boolean;
  payloadBytes: number;
  originalPayloadBytes: number;
  createdAt: number;
}

export interface DirectAuditEventDetail extends DirectAuditEvent {
  payload: unknown;
}

interface SessionRow {
  id: string;
  owner_id: string;
  principal_id: string;
  credential_id: string;
  grant_id: string;
  explicit_key: string | null;
  heuristic_key: string;
  created_at: number;
  last_event_at: number;
  event_count: number;
  bytes_total: number;
}

/**
 * Owner-wide retained bytes. The per-session share comes from the session
 * row's running total, but the owner share is an index-assisted SUM scan —
 * the same trade-off as the Answer precedent (`store-audit.ts`). Cheap
 * enough per call; revisit with a per-owner total if Direct volume ever
 * makes the scan visible.
 */
function ownerDirectAuditBytesUsed(db: PrivacyDb, ownerId: string): number {
  return (
    db
      .prepare<
        [string],
        { bytes: number }
      >(`SELECT COALESCE(SUM(payload_bytes), 0) AS bytes FROM direct_audit_events WHERE owner_id = ?`)
      .get(ownerId)?.bytes ?? 0
  );
}

function encodeDirectPayload(
  db: PrivacyDb,
  sessionBytesTotal: number,
  ownerId: string,
  payload: unknown,
): {
  json: string;
  digest: string;
  originalBytes: number;
  retainedBytes: number;
  truncated: boolean;
} {
  const raw = JSON.stringify(payload);
  if (raw === undefined) throw new TypeError("Direct audit payload must be JSON serializable.");
  const digest = createHash("sha256").update(raw, "utf8").digest("hex");
  const originalBytes = Buffer.byteLength(raw, "utf8");
  const ownerUsed = ownerDirectAuditBytesUsed(db, ownerId);
  const reason =
    originalBytes > MAX_DIRECT_AUDIT_EVENT_BYTES
      ? "event_limit"
      : sessionBytesTotal + originalBytes > MAX_DIRECT_AUDIT_SESSION_BYTES
        ? "session_limit"
        : ownerUsed + originalBytes > MAX_DIRECT_AUDIT_OWNER_BYTES
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

function findOrCreateSession(db: PrivacyDb, input: AppendDirectAuditEventInput): SessionRow {
  const keys = directSessionKeys(input);
  if (keys.explicitKey !== null) {
    // Scoped by caller identity, not just the key: two agents under one
    // owner reusing the same conversation id must not merge transcripts,
    // and then per-event attribution is simply the session's.
    const existing = db
      .prepare<[string, string, string, string], SessionRow>(
        `SELECT * FROM direct_audit_sessions
         WHERE owner_id = ? AND principal_id = ? AND credential_id = ? AND explicit_key = ?`,
      )
      .get(input.ownerId, input.principalId, input.credentialId, keys.explicitKey);
    if (existing) return existing;
    const row: SessionRow = {
      id: `direct_${randomUUID()}`,
      owner_id: input.ownerId,
      principal_id: input.principalId,
      credential_id: input.credentialId,
      grant_id: input.grantId,
      explicit_key: keys.explicitKey,
      heuristic_key: keys.heuristicKey,
      created_at: input.now,
      last_event_at: input.now,
      event_count: 0,
      bytes_total: 0,
    };
    db.prepare(
      `INSERT INTO direct_audit_sessions (
         id, owner_id, principal_id, credential_id, grant_id,
         explicit_key, heuristic_key, created_at, last_event_at, event_count, bytes_total
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.owner_id,
      row.principal_id,
      row.credential_id,
      row.grant_id,
      row.explicit_key,
      row.heuristic_key,
      row.created_at,
      row.last_event_at,
      row.event_count,
      row.bytes_total,
    );
    return row;
  }
  const latest = db
    .prepare<[string, string], SessionRow>(
      `SELECT * FROM direct_audit_sessions
       WHERE owner_id = ? AND heuristic_key = ? AND explicit_key IS NULL
       ORDER BY last_event_at DESC LIMIT 1`,
    )
    .get(input.ownerId, keys.heuristicKey);
  if (latest && input.now - latest.last_event_at <= DIRECT_HEURISTIC_SESSION_GAP_MS) return latest;
  const row: SessionRow = {
    id: `direct_${randomUUID()}`,
    owner_id: input.ownerId,
    principal_id: input.principalId,
    credential_id: input.credentialId,
    grant_id: input.grantId,
    explicit_key: null,
    heuristic_key: keys.heuristicKey,
    created_at: input.now,
    last_event_at: input.now,
    event_count: 0,
    bytes_total: 0,
  };
  db.prepare(
    `INSERT INTO direct_audit_sessions (
       id, owner_id, principal_id, credential_id, grant_id,
       explicit_key, heuristic_key, created_at, last_event_at, event_count, bytes_total
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.owner_id,
    row.principal_id,
    row.credential_id,
    row.grant_id,
    row.explicit_key,
    row.heuristic_key,
    row.created_at,
    row.last_event_at,
    row.event_count,
    row.bytes_total,
  );
  return row;
}

function sessionFromRow(row: SessionRow, principalName: string | null = null): DirectAuditSession {
  return {
    id: row.id,
    ownerId: row.owner_id,
    principalId: row.principal_id,
    principalName,
    credentialId: row.credential_id,
    grantId: row.grant_id,
    explicitKey: row.explicit_key,
    heuristicKey: row.heuristic_key,
    createdAt: row.created_at,
    lastEventAt: row.last_event_at,
    eventCount: row.event_count,
    bytesTotal: row.bytes_total,
  };
}

/**
 * Fill each session's operator-approved principal name in one query. A store
 * opened over only the transcript tables is legitimate — the same posture as
 * the Answer identity joins — so a missing access table costs the null name
 * and nothing more.
 */
function attachPrincipalNames(db: PrivacyDb, sessions: DirectAuditSession[]): void {
  const ids = [...new Set(sessions.map((session) => session.principalId))];
  if (ids.length === 0) return;
  const hasName = Boolean(
    db
      .prepare<
        [string],
        { found: number }
      >(`SELECT 1 AS found FROM pragma_table_info('access_principals') WHERE name = ?`)
      .get("name"),
  );
  if (!hasName) return;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare<
      string[],
      { id: string; name: string | null }
    >(`SELECT id, name FROM access_principals WHERE id IN (${placeholders})`)
    .all(...ids);
  const names = new Map(rows.map((row) => [row.id, row.name?.trim() || null]));
  for (const session of sessions) {
    session.principalName = names.get(session.principalId) ?? null;
  }
}

/**
 * Resolve the caller's session and append one transcript event carrying the
 * bounded tool arguments and result. Runs inside the caller's writer
 * transaction — the lookup is one indexed read and the insert is one row
 * plus its payload, so a transcript write never holds the writer lock over
 * corpus I/O.
 */
export function appendDirectAuditEvent(
  db: PrivacyDb,
  input: AppendDirectAuditEventInput,
): { session: DirectAuditSession; eventId: string } {
  const session = findOrCreateSession(db, input);
  const eventId = `directevent_${randomUUID()}`;
  const encoded = encodeDirectPayload(db, session.bytes_total, input.ownerId, {
    tool: input.tool,
    args: boundDirectAuditValue(input.args),
    result: input.result === undefined ? null : boundDirectAuditValue(input.result),
    outcome: input.outcome,
  });
  const payloadId = `payload_${eventId}`;
  db.prepare(
    `INSERT INTO direct_audit_events (
       id, session_id, owner_id, tool, outcome, request_id, display_json,
       payload_id, payload_digest, payload_bytes, original_payload_bytes,
       payload_truncated, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    session.id,
    input.ownerId,
    input.tool,
    input.outcome,
    input.requestId,
    JSON.stringify(
      auditDisplay({
        title: `Direct ${input.tool}`,
        text: `Raw corpus read finished with outcome ${input.outcome}.`,
      }),
    ),
    payloadId,
    encoded.digest,
    encoded.retainedBytes,
    encoded.originalBytes,
    encoded.truncated ? 1 : 0,
    input.now,
  );
  db.prepare("INSERT INTO direct_audit_payloads (id, event_id, payload_json) VALUES (?, ?, ?)").run(
    payloadId,
    eventId,
    encoded.json,
  );
  db.prepare(
    `UPDATE direct_audit_sessions
     SET last_event_at = ?, event_count = event_count + 1,
         bytes_total = bytes_total + ? WHERE id = ?`,
  ).run(input.now, encoded.retainedBytes, session.id);
  const updated = db
    .prepare<[string], SessionRow>(`SELECT * FROM direct_audit_sessions WHERE id = ?`)
    .get(session.id);
  if (!updated) throw new Error("Direct audit session vanished mid-append.");
  const returned = sessionFromRow(updated);
  attachPrincipalNames(db, [returned]);
  return { session: returned, eventId };
}

export function listDirectAuditSessions(
  db: PrivacyDb,
  ownerId: string | null,
  limit: number,
): DirectAuditSession[] {
  const rows =
    ownerId === null
      ? db
          .prepare<[number], SessionRow>(
            `SELECT * FROM direct_audit_sessions
             ORDER BY last_event_at DESC, id DESC LIMIT ?`,
          )
          .all(limit)
      : db
          .prepare<[string, number], SessionRow>(
            `SELECT * FROM direct_audit_sessions WHERE owner_id = ?
             ORDER BY last_event_at DESC, id DESC LIMIT ?`,
          )
          .all(ownerId, limit);
  const sessions = rows.map((row) => sessionFromRow(row));
  attachPrincipalNames(db, sessions);
  return sessions;
}

interface EventRow {
  sequence: number;
  id: string;
  session_id: string;
  tool: string;
  outcome: string;
  request_id: string;
  display_json: string;
  payload_truncated: number;
  payload_bytes: number;
  original_payload_bytes: number;
  created_at: number;
}

const DIRECT_AUDIT_OUTCOMES: ReadonlySet<string> = new Set([
  "ok",
  "refused",
  "cancelled",
  "timed_out",
  "failed",
]);

function eventFromRow(row: EventRow): DirectAuditEvent {
  let title = row.tool;
  let text: string | null = null;
  try {
    const display = JSON.parse(row.display_json) as { title?: unknown; text?: unknown };
    if (typeof display.title === "string") title = display.title;
    if (typeof display.text === "string") text = display.text;
  } catch {
    // A row whose display is not an object reads with bare defaults.
  }
  return {
    sequence: row.sequence,
    id: row.id,
    sessionId: row.session_id,
    tool: row.tool,
    outcome: DIRECT_AUDIT_OUTCOMES.has(row.outcome)
      ? (row.outcome as McpInvocationAuditOutcome)
      : "failed",
    requestId: row.request_id,
    display: { title, text },
    payloadTruncated: row.payload_truncated === 1,
    payloadBytes: row.payload_bytes,
    originalPayloadBytes: row.original_payload_bytes,
    createdAt: row.created_at,
  };
}

export function directAuditSessionExists(
  db: PrivacyDb,
  ownerId: string | null,
  sessionId: string,
): boolean {
  const where = ownerId === null ? `id = ?` : `owner_id = ? AND id = ?`;
  const params = ownerId === null ? [sessionId] : [ownerId, sessionId];
  return db.prepare(`SELECT 1 FROM direct_audit_sessions WHERE ${where}`).get(...params) != null;
}

export function listDirectAuditEvents(
  db: PrivacyDb,
  ownerId: string | null,
  sessionId: string,
  limit: number,
): DirectAuditEvent[] {
  const where = ownerId === null ? `session_id = ?` : `owner_id = ? AND session_id = ?`;
  const params = ownerId === null ? [sessionId, limit] : [ownerId, sessionId, limit];
  return db
    .prepare<Array<string | number>, EventRow>(
      `SELECT sequence, id, session_id, tool, outcome, request_id, display_json,
              payload_truncated, payload_bytes, original_payload_bytes, created_at
       FROM direct_audit_events WHERE ${where}
       ORDER BY sequence ASC LIMIT ?`,
    )
    .all(...params)
    .map(eventFromRow);
}

export function getDirectAuditEvent(
  db: PrivacyDb,
  ownerId: string | null,
  eventId: string,
): DirectAuditEventDetail | null {
  const where = ownerId === null ? `id = ?` : `owner_id = ? AND id = ?`;
  const params = ownerId === null ? [eventId] : [ownerId, eventId];
  const row = db
    .prepare<Array<string>, EventRow>(
      `SELECT sequence, id, session_id, tool, outcome, request_id, display_json,
              payload_truncated, payload_bytes, original_payload_bytes, created_at
       FROM direct_audit_events WHERE ${where}`,
    )
    .get(...params);
  if (!row) return null;
  const payload = db
    .prepare<
      [string],
      { payload_json: string }
    >(`SELECT payload_json FROM direct_audit_payloads WHERE event_id = ?`)
    .get(eventId);
  let parsed: unknown = null;
  if (payload) {
    try {
      parsed = JSON.parse(payload.payload_json) as unknown;
    } catch {
      parsed = null;
    }
  }
  return { ...eventFromRow(row), payload: parsed };
}

/** Delete one session; events and payloads follow via ON DELETE CASCADE. */
export function deleteDirectAuditSession(
  db: PrivacyDb,
  ownerId: string | null,
  sessionId: string,
): boolean {
  const where = ownerId === null ? `id = ?` : `owner_id = ? AND id = ?`;
  const params = ownerId === null ? [sessionId] : [ownerId, sessionId];
  const result = db.prepare(`DELETE FROM direct_audit_sessions WHERE ${where}`).run(...params);
  return result.changes > 0;
}
