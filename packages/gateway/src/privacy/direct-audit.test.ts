// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  appendDirectAuditEvent,
  deleteDirectAuditSession,
  getDirectAuditEvent,
  listDirectAuditEvents,
  listDirectAuditSessions,
  type AppendDirectAuditEventInput,
} from "./direct-audit.js";
import { DIRECT_HEURISTIC_SESSION_GAP_MS } from "./direct-session.js";
import { createDirectAuditTables } from "./store-schema.js";

const OWNER = "owner_fictional";
const BASE: Omit<AppendDirectAuditEventInput, "tool" | "requestId" | "now"> = {
  ownerId: OWNER,
  principalId: "principal_fictional",
  credentialId: "credential_fictional",
  grantId: "grant_fictional",
  outcome: "ok",
  args: { query: "fictional schedule" },
  result: { documents: [{ id: "doc_1" }] },
};

describe("direct audit store", () => {
  let db: Database.Database;
  let now: number;
  let serial: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    createDirectAuditTables(db);
    now = 1_700_000_000_000;
    serial = 0;
  });

  function append(
    overrides: Partial<AppendDirectAuditEventInput> = {},
  ): ReturnType<typeof appendDirectAuditEvent> {
    serial += 1;
    return appendDirectAuditEvent(db, {
      ...BASE,
      tool: "search_many",
      requestId: `request_${serial}`,
      now,
      ...overrides,
    });
  }

  it("groups consecutive calls without keys into one heuristic session", () => {
    const first = append();
    now += 1_000;
    const second = append({ tool: "fetch_many" });
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.eventCount).toBe(2);
    expect(second.session.explicitKey).toBeNull();
    expect(listDirectAuditEvents(db, OWNER, first.session.id, 10)).toHaveLength(2);
  });

  it("splits the heuristic session after the idle gap", () => {
    const first = append();
    now += DIRECT_HEURISTIC_SESSION_GAP_MS + 1;
    const second = append();
    expect(second.session.id).not.toBe(first.session.id);
    expect(listDirectAuditSessions(db, OWNER, 10)).toHaveLength(2);
  });

  it("keeps an explicit conversation session whole across the idle gap", () => {
    const first = append({ conversationId: "conv_fictional" });
    expect(first.session.explicitKey).toBe("conversation:conv_fictional");
    now += DIRECT_HEURISTIC_SESSION_GAP_MS * 3;
    const second = append({ conversationId: "conv_fictional" });
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.eventCount).toBe(2);
  });

  it("isolates sessions by credential", () => {
    const first = append();
    const second = append({ credentialId: "credential_other" });
    expect(second.session.id).not.toBe(first.session.id);
  });

  it("scopes explicit keys by caller identity", () => {
    const first = append({ conversationId: "conv_shared" });
    const sameCaller = append({ conversationId: "conv_shared" });
    expect(sameCaller.session.id).toBe(first.session.id);
    const otherCredential = append({
      conversationId: "conv_shared",
      credentialId: "credential_other",
    });
    expect(otherCredential.session.id).not.toBe(first.session.id);
    const otherPrincipal = append({
      conversationId: "conv_shared",
      principalId: "principal_other",
      credentialId: "credential_other",
    });
    expect(otherPrincipal.session.id).not.toBe(first.session.id);
    expect(otherPrincipal.session.id).not.toBe(otherCredential.session.id);
  });

  it("accumulates retained bytes on the session row", () => {
    const first = append();
    expect(first.session.bytesTotal).toBeGreaterThan(0);
    now += 1_000;
    const second = append({ tool: "fetch_many" });
    expect(second.session.bytesTotal).toBeGreaterThan(first.session.bytesTotal);
  });

  it("truncates once a session exceeds its byte budget", () => {
    // Bounding applies per top-level args/result value (128 KB each), so an
    // event retains at most ~256 KB: seventy near-cap events pass the 16 MB
    // session budget and the tail is stored as a sentinel.
    const pad = "x".repeat(120 * 1024);
    let lastEventId = "";
    for (let i = 0; i < 70; i += 1) {
      now += 1_000;
      lastEventId = append({ args: { pad }, result: { pad } }).eventId;
    }
    const detail = getDirectAuditEvent(db, OWNER, lastEventId);
    expect(detail?.payloadTruncated).toBe(true);
    expect(detail?.payload).toMatchObject({ truncated: true, reason: "session_limit" });
  });

  it("refuses unknown outcomes at the schema boundary", () => {
    expect(() =>
      append({ outcome: "newfangled" as unknown as AppendDirectAuditEventInput["outcome"] }),
    ).toThrow(/CHECK constraint failed/);
  });

  it("stores bounded args and results in the payload", () => {
    const { eventId } = append();
    const detail = getDirectAuditEvent(db, OWNER, eventId);
    expect(detail).not.toBeNull();
    expect(detail?.tool).toBe("search_many");
    expect(detail?.payloadTruncated).toBe(false);
    expect(detail?.payload).toMatchObject({
      tool: "search_many",
      args: { query: "fictional schedule" },
      outcome: "ok",
    });
  });

  it("records refused calls without a result", () => {
    const { eventId } = append({ outcome: "refused", result: undefined });
    const detail = getDirectAuditEvent(db, OWNER, eventId);
    expect(detail?.outcome).toBe("refused");
    expect(detail?.payload).toMatchObject({ result: null, outcome: "refused" });
  });

  it("truncates oversized values with a digest sentinel", () => {
    const { eventId } = append({ result: { blob: "x".repeat(300 * 1024) } });
    const detail = getDirectAuditEvent(db, OWNER, eventId);
    expect(detail?.payloadTruncated).toBe(false);
    const payload = detail?.payload as { result: Record<string, unknown> };
    expect(payload.result).toMatchObject({ truncated: true, reason: "tool_payload_limit" });
  });

  it("lists sessions newest first and scopes reads by owner", () => {
    const first = append();
    now += 5_000;
    append({ conversationId: "conv_fictional" });
    const sessions = listDirectAuditSessions(db, OWNER, 10);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.explicitKey).toBe("conversation:conv_fictional");
    expect(sessions[1]?.id).toBe(first.session.id);
    expect(listDirectAuditSessions(db, "owner_other", 10)).toHaveLength(0);
    expect(getDirectAuditEvent(db, "owner_other", first.eventId)).toBeNull();
  });

  it("leaves the principal name null when the access tables are absent", () => {
    append();
    expect(listDirectAuditSessions(db, OWNER, 10)[0]?.principalName).toBeNull();
  });

  it("attaches the operator-approved principal name to listed sessions", () => {
    db.exec(`CREATE TABLE access_principals (id TEXT PRIMARY KEY, name TEXT NOT NULL);`);
    db.prepare(`INSERT INTO access_principals (id, name) VALUES (?, ?)`).run(
      "principal_fictional",
      "  Fictional Agent  ",
    );
    const { session } = append();
    expect(session.principalName).toBe("Fictional Agent");
    expect(listDirectAuditSessions(db, OWNER, 10)[0]?.principalName).toBe("Fictional Agent");
  });

  it("deletes a session with its events and payloads", () => {
    const { session, eventId } = append();
    expect(deleteDirectAuditSession(db, OWNER, session.id)).toBe(true);
    expect(deleteDirectAuditSession(db, OWNER, session.id)).toBe(false);
    expect(listDirectAuditSessions(db, OWNER, 10)).toHaveLength(0);
    expect(getDirectAuditEvent(db, OWNER, eventId)).toBeNull();
    const payloads = db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM direct_audit_payloads`)
      .get()?.n;
    expect(payloads).toBe(0);
  });
});
