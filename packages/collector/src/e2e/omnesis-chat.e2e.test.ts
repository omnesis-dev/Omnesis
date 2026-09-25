// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end coverage for the omnesis-chat built-in source
 * (Type A: conversations as first-class documents).
 *
 * Boots a real gateway subprocess with the replay agent backend wired
 * to the default universe's `agent-demos/`. Sets
 * `OMNESIS_CHAT_DEBOUNCE_MS=0` so the per-session debounce window
 * collapses and the conversation document lands the instant a turn
 * completes.
 *
 * Flow:
 *   1. Sync every synth source so `$DOC_<externalId>` placeholders the
 *      `citation-edge-cases` scenario references resolve.
 *   2. Drive a "ground this" message → agent emits annotate calls,
 *      then `agent.message.end`.
 *   3. Read the gateway DB directly (no HTTP endpoint covers
 *      `document_links` filtered by source_doc_id) to assert:
 *        - one `documents` row at (system, omnesis-chat, sessionId)
 *        - body is dialogue-only (no annotated snippets)
 *        - one `document_links` row per annotate call with the
 *          full JSON metadata payload on each
 *   4. DELETE /agent/conversations/:id → conversation doc disappears.
 */

import "./synth-env.js";
import { existsSync } from "node:fs";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type DatabaseModule from "better-sqlite3";

type Db = DatabaseModule.Database;

const TURN_TIMEOUT_MS = 60_000;

// Trigger from `citation-edge-cases.meta.json`. The scenario emits
// multiple annotate calls (notion page × 2, plus a calendar event).
const TRIGGER_PHRASE = "ground this";

// External IDs the scenario annotates against — defined in the same
// universe's synth source fixtures, hard-coded in the JSONL.
const ANNOTATED_NOTION_EXTID = "synth-notion-page-003";
const ANNOTATED_CALENDAR_EXTID = "synth-gcal-003";

interface AgentEvent {
  type: string;
  payload: Record<string, unknown>;
}

interface SessionResp {
  sessionId: string;
}

interface MessageResp {
  messageId: string;
}

describe("omnesis-chat source — end-to-end (Part 1)", () => {
  let harness: SyntheticE2EHarness;
  let db: Db;

  beforeAll(async () => {
    // Collapse the per-session upsert debounce so the test doesn't
    // wait the production 30s window before observing the doc. The
    // env var propagates into the spawned gateway via `...process.env`
    // spread inside the harness's startGateway().
    process.env.OMNESIS_CHAT_DEBOUNCE_MS = "0";

    harness = new SyntheticE2EHarness({ gatewayMode: "stable", agentBackend: "replay" });
    await harness.start();

    // Sync every source so the placeholder resolver inside the replay
    // factory can map `$DOC_<externalId>` → the gateway-assigned UUID.
    // Without this the annotate tool result carries a sentinel rather
    // than a real doc id, and the link upsert fails the FK check.
    await harness.syncAllSources();

    db = new Database(harness.getDbPath(), { readonly: true });
  }, 240_000);

  afterAll(async () => {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
    await harness?.destroy();
    delete process.env.OMNESIS_CHAT_DEBOUNCE_MS;
  });

  test("conversation becomes a document with citation edges; DELETE cascades", async () => {
    // Sanity: the universe must have populated the two docs the scenario
    // wants to annotate. Without them the scenario fires but the link
    // FK fails and the citation count would be zero.
    const notionDoc = db
      .prepare<
        [string, string],
        { id: string }
      >("SELECT id FROM documents WHERE source_id LIKE ? AND external_id = ? LIMIT 1")
      .get("notion-pages:%", ANNOTATED_NOTION_EXTID);
    const calendarDoc = db
      .prepare<
        [string, string],
        { id: string }
      >("SELECT id FROM documents WHERE source_id LIKE ? AND external_id = ? LIMIT 1")
      .get("google-calendar:%", ANNOTATED_CALENDAR_EXTID);
    expect(notionDoc?.id).toBeTruthy();
    expect(calendarDoc?.id).toBeTruthy();

    const sessionId = await runReplayTurn(harness, TRIGGER_PHRASE);

    // Wait for the conversation document to land. Even with debounce=0
    // the upsert is async (loadConversation → renderConversation →
    // upsertDocuments → upsertConversationCitations), so we poll.
    const convId = await waitForConversationDoc(db, sessionId, 5_000);
    expect(convId).toBeTruthy();

    // The conversation transcript file must exist on disk — Part 1
    // keeps the JSON as the source of truth.
    expect(existsSync(`${harness.getConversationsDir()}/${sessionId}.json`)).toBe(true);

    // Body shape — must contain the user's trigger phrase and the
    // "You"/"Omnesis" speaker headers. Annotated snippets MUST NOT
    // appear (they live on edges, not in the body).
    const docRow = db
      .prepare<
        [string],
        { content: string; source_id: string; title: string; metadata: string }
      >("SELECT content, source_id, title, metadata FROM documents WHERE id = ?")
      .get(convId) as
      | { content: string; source_id: string; title: string; metadata: string }
      | undefined;
    expect(docRow?.source_id).toBe("omnesis-chat");
    expect(docRow?.content).toContain(TRIGGER_PHRASE);
    expect(docRow?.content).toContain("**You**");
    expect(docRow?.content).toContain("**Omnesis**");
    // No annotation quotes leak into body — those snippets are from
    // the scenario's annotate calls and would surface here only if
    // the rendering rules forgot to drop tool I/O.
    expect(docRow?.content).not.toContain("Globex pending SOC2");
    expect(docRow?.content).not.toContain("Comparison axes:");

    // Citation edges — one per annotate call. The scenario emits three
    // notion annotations (two with quotes, one note-only) plus one
    // calendar annotation.
    const linkStmt = db.prepare<
      [string, string],
      {
        target_doc_id: string;
        link_type: string;
        metadata_json: string | null;
        normalized_target: string;
      }
    >(
      "SELECT target_doc_id, link_type, metadata_json, normalized_target FROM document_links WHERE source_doc_id = ? AND link_type = ? ORDER BY id",
    );
    const linkRows = await pollUntil(() => {
      const rows = linkStmt.all(convId, "cited");
      return rows.length >= 2 ? rows : null;
    }, 10_000);
    if (!linkRows) throw new Error("conversation citation edges did not arrive");

    // Each row carries the JSON payload (quote / quoteAuthor / note)
    // serialized to `metadata_json`. At least one with a quote, at
    // least one with a bare note — the scenario covers both.
    const parsed = linkRows
      .map((r) => (r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : {}))
      .filter((m) => Object.keys(m).length > 0);
    expect(parsed.some((m) => typeof m.quote === "string")).toBe(true);
    expect(parsed.some((m) => typeof m.note === "string")).toBe(true);

    // Targets resolve to the synth docs we sanity-checked above.
    const targets = new Set(linkRows.map((r) => r.target_doc_id));
    expect(targets.has(notionDoc!.id)).toBe(true);
    expect(targets.has(calendarDoc!.id)).toBe(true);

    // Synthetic raw_target encodes the docId + annotation index so the
    // UNIQUE(source_doc_id, link_type, normalized_target) constraint
    // doesn't fold multiple annotations of the same target.
    for (const r of linkRows) {
      expect(r.normalized_target).toMatch(/^omnesis:\/\/doc\/[0-9a-f-]+#\d+$/i);
    }

    // ── Re-upsert on a second turn ────────────────────────────────
    const firstUpdatedAt = (db
      .prepare<
        [string],
        { updated_at: string; metadata: string }
      >("SELECT updated_at, metadata FROM documents WHERE id = ?")
      .get(convId) as { updated_at: string; metadata: string } | undefined)!;
    const firstMessageCount = (
      JSON.parse(firstUpdatedAt.metadata) as {
        extra?: { messageCount?: number };
      }
    ).extra?.messageCount;

    await sendFollowUpTurn(harness, sessionId, "second message about the launch");
    // Wait for the second debounced upsert (debounce=0 + writer queue).
    await waitForDocChange(db, convId, firstUpdatedAt.updated_at, 5_000);

    const after2 = db
      .prepare<
        [string],
        { content: string; metadata: string }
      >("SELECT content, metadata FROM documents WHERE id = ?")
      .get(convId) as { content: string; metadata: string };
    expect(after2.content).toContain("second message about the launch");
    const newMessageCount = (
      JSON.parse(after2.metadata) as {
        extra?: { messageCount?: number };
      }
    ).extra?.messageCount;
    expect(newMessageCount ?? 0).toBeGreaterThan(firstMessageCount ?? 0);

    // ── Search retrievability ────────────────────────────────────
    // The whole point of the source is that conversations become
    // searchable. The synth E2E harness boots without an embedding
    // model, so `POST /search` (BM25 + vector) returns nothing; the
    // LIKE-based `GET /documents/search` is the canonical substitute
    // for this layer of assertion (see golden-corpus.e2e for the same
    // trade-off). The presence of the row in `documents` already gives
    // BM25 + vector their input — this assert just proves the LIKE
    // path can reach it the same way `/search` would once the
    // embedder is online.
    const searchHit = await pollUntil(async () => {
      const url = `${harness.gatewayUrl}/documents/search?q=${encodeURIComponent(
        "second message about the launch",
      )}&limit=20`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${harness.apiKey}` },
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { results?: Array<{ id?: string }> };
      return j.results?.find((r) => r.id === convId) ?? null;
    }, 10_000);
    expect(searchHit, "conversation doc not found in /documents/search").toBeTruthy();

    // ── DELETE cascade ────────────────────────────────────────────
    const delRes = await fetch(`${harness.gatewayUrl}/agent/conversations/${sessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${harness.apiKey}` },
    });
    expect(delRes.ok).toBe(true);

    // After DELETE the doc and its edges must be gone.
    const after = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE id = ?")
      .get(convId);
    expect(after).toBeUndefined();
    const edgesAfter = db
      .prepare<
        [string],
        { c: number }
      >("SELECT COUNT(*) as c FROM document_links WHERE source_doc_id = ?")
      .get(convId);
    expect(edgesAfter?.c ?? -1).toBe(0);
  });
});

async function sendFollowUpTurn(
  harness: SyntheticE2EHarness,
  sessionId: string,
  text: string,
): Promise<void> {
  // The replay backend doesn't route every user message to a scenario;
  // a free-form follow-up returns the default scenario (or stays idle
  // depending on universe). We don't care what the agent says — we
  // only need the user's text in the transcript so the next upsert
  // sees a new message.
  const sse = await fetch(`${harness.gatewayUrl}/agent/events`, {
    headers: {
      Authorization: `Bearer ${harness.apiKey}`,
      Accept: "text/event-stream",
    },
  });
  if (!sse.ok || !sse.body) {
    throw new Error(`SSE subscribe failed: ${sse.status} ${await sse.text()}`);
  }
  const reader = sse.body.getReader();
  try {
    const msgRes = await fetch(`${harness.gatewayUrl}/agent/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!msgRes.ok) {
      throw new Error(`message send failed: ${msgRes.status} ${await msgRes.text()}`);
    }
    const sent = (await msgRes.json()) as MessageResp;
    await readEventsUntilMessageEnd(reader, sessionId, sent.messageId);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
}

async function waitForDocChange(
  db: Db,
  docId: string,
  knownUpdatedAt: string,
  timeoutMs: number,
): Promise<void> {
  const stmt = db.prepare<[string], { updated_at: string }>(
    "SELECT updated_at FROM documents WHERE id = ?",
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = stmt.get(docId);
    if (row && row.updated_at !== knownUpdatedAt) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`doc ${docId} did not change updated_at within ${timeoutMs}ms`);
}

async function pollUntil<T>(
  fn: () => T | null | Promise<T | null>,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function runReplayTurn(harness: SyntheticE2EHarness, trigger: string): Promise<string> {
  const sse = await fetch(`${harness.gatewayUrl}/agent/events`, {
    headers: {
      Authorization: `Bearer ${harness.apiKey}`,
      Accept: "text/event-stream",
    },
  });
  if (!sse.ok || !sse.body) {
    throw new Error(`SSE subscribe failed: ${sse.status} ${await sse.text()}`);
  }
  const reader = sse.body.getReader();
  try {
    const sessionRes = await fetch(`${harness.gatewayUrl}/agent/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!sessionRes.ok) {
      throw new Error(`session create failed: ${sessionRes.status} ${await sessionRes.text()}`);
    }
    const session = (await sessionRes.json()) as SessionResp;

    const msgRes = await fetch(
      `${harness.gatewayUrl}/agent/sessions/${session.sessionId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${harness.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: trigger }),
      },
    );
    if (!msgRes.ok) {
      throw new Error(`message send failed: ${msgRes.status} ${await msgRes.text()}`);
    }
    const sent = (await msgRes.json()) as MessageResp;
    await readEventsUntilMessageEnd(reader, session.sessionId, sent.messageId);
    return session.sessionId;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
}

async function readEventsUntilMessageEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sessionId: string,
  messageId: string,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value?: undefined }>((r) =>
        setTimeout(() => r({ done: true as const }), remaining),
      ),
    ]);
    if (next.done || !next.value) break;
    buffer += decoder.decode(next.value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice("data:".length).trim();
      if (!json) continue;
      try {
        const parsed = JSON.parse(json) as AgentEvent;
        if (parsed.payload?.sessionId !== sessionId) continue;
        events.push(parsed);
        if (parsed.type === "agent.message.end" && parsed.payload?.messageId === messageId) {
          return events;
        }
      } catch {
        /* skip */
      }
    }
  }
  throw new Error(
    `Did not see agent.message.end for ${sessionId}/${messageId} within ${TURN_TIMEOUT_MS}ms`,
  );
}

async function waitForConversationDoc(
  db: Db,
  sessionId: string,
  timeoutMs: number,
): Promise<string> {
  const stmt = db.prepare<[string, string, string], { id: string }>(
    "SELECT id FROM documents WHERE provider_id = ? AND source_id = ? AND external_id = ?",
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = stmt.get("system", "omnesis-chat", sessionId);
    if (row?.id) return row.id;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`conversation doc for ${sessionId} not visible after ${timeoutMs}ms`);
}
