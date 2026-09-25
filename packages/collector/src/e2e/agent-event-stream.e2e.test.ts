// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The agent's live event stream as a disconnecting client actually consumes
 * it: a sequence that survives a drop, a terminal that tells the truth about
 * a truncated answer, and one batch citation that fans out the same way on
 * the wire and in the corpus.
 *
 * Every invariant here needs a real HTTP round trip. `AgentService.subscribe`
 * replays the ring buffer synchronously before it attaches the live listener,
 * so an in-process caller cannot observe a route-level reorder — the initial
 * heartbeat, the SSE framing, or an `await` slipped between replay and
 * attach. The other suites that open `/agent/events` all open a bare stream
 * and read to `agent.message.end`; none of them hands the gateway a
 * `Last-Event-ID`, so the resume seam has never crossed the wire.
 *
 * The suite brings its own replay cassettes rather than borrowing a
 * universe's. `SyntheticE2EHarness` overwrites `OMNESIS_AGENT_FIXTURE`
 * whenever it is constructed with `agentBackend: "replay"`, so the agent is
 * enabled the other way instead — `extraInference.assignments.agent =
 * "replay"` with the fixture directory exported into the environment the
 * spawned gateway inherits. Private cassettes keep these scenarios out of
 * `replay-scenarios.e2e.test.ts`, which drives every cassette a universe
 * ships, and let one of them do what no in-tree cassette does: record three
 * citations in a single `annotate_many`. That call is deliberately LIVE — an
 * `agent.tool.start` the fixture never resolves — so the three-item
 * `annotate.batch` is built by `runBatch` and the real `annotate` tool rather
 * than hand-forged into the JSONL. The fan-out under test is production's.
 *
 * Timing is never the gate. Waits end on a frame arriving, a frame count, a
 * persisted record changing shape, or a row appearing in the gateway DB. The
 * one place time itself is the subject — a sequence id minted by a process
 * that no longer exists — is driven by restarting the gateway rather than by
 * waiting for anything to expire.
 */

import "./synth-env.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { waitForCondition } from "./multi-collector-harness.js";
import type DatabaseModule from "better-sqlite3";

type Db = DatabaseModule.Database;

/** Generous per-test budget: two E2E files share this machine. */
const TEST_TIMEOUT_MS = 120_000;
/** The stale-cursor test additionally pays `restartGateway`'s down-wait + boot budget. */
const RESTART_TEST_TIMEOUT_MS = 240_000;
/** How long any single stream read may stall before the suite gives up. */
const FRAME_TIMEOUT_MS = 60_000;
/** How long a persisted-record / DB-row barrier may take. */
const BARRIER_TIMEOUT_MS = 60_000;

// The three cited documents. Fictional content, per the privacy rule.
const DOC_A_EXT = "stream-e2e-doc-a";
const DOC_B_EXT = "stream-e2e-doc-b";
const DOC_C_EXT = "stream-e2e-doc-c";

const QUOTE_A = "Riverside outline names the two remaining blockers.";
const NOTE_B = "Budget note with no quotable body of its own.";
const QUOTE_C = "The vendor quoted four weeks, end to end, with no overlap.";
const QUOTE_C_AUTHOR = "Maya";

const TRIGGER_CITE = "cite three of my documents";
const TRIGGER_LONG = "stream the long answer";
const TRIGGER_TRUNCATE = "truncate the answer";

/**
 * ~1.2 kB of invented prose. The fixture directory pins `textStreamChars: 4`
 * / `textStreamMs: 44`, so this single delta becomes ~190 discrete SSE frames
 * over ~8s — a tail long enough that a client can disconnect inside it and
 * still have most of the answer ahead of it, however loaded the box is. Load
 * cannot shrink that window: it delays the gateway's own chunk timers at
 * least as much as it delays the reconnecting client.
 */
const LONG_ANSWER =
  "The migration splits into three tracks that can run in parallel once the " +
  "shared schema lands. Track one moves the ingest workers behind the new " +
  "queue and keeps the old path warm for a week so a rollback costs a config " +
  "flag rather than a redeploy. Track two rewrites the reconciler to read " +
  "from the snapshot table instead of walking every row, which is where the " +
  "current tail latency comes from. Track three is documentation and the " +
  "operator runbook, and it is the one most likely to slip, so it starts " +
  "first. None of the three needs the others to finish; they only need the " +
  "schema, and the schema is one afternoon of work plus a migration that has " +
  "already been written and reviewed twice. The sequencing question is " +
  "therefore not which track is hardest but which one blocks a rollback, and " +
  "on that reading the queue cutover is the only irreversible step in the " +
  "whole plan. Everything else can be reverted by pointing the reconciler " +
  "back at the row walk and accepting the old latency for an afternoon. So " +
  "the queue goes last, behind a flag, after both other tracks have been " +
  "running against real traffic for a week and the runbook has been read " +
  "aloud by somebody who did not write it.";

/**
 * A deliberately half-finished sentence. The `truncated` cassette ends on
 * `stopReason: "max_tokens"` with no `failure` field, so the session has to
 * synthesise the terminal failure itself.
 */
const PARTIAL_ANSWER = "The three release blockers are: first, the staging cluster still";

/**
 * The operator-visible notice a truncated turn carries, restated rather than
 * imported: `@omnesis/agent` (which declares it) is not a dependency of this
 * package, and pinning the sentence here is the stronger assertion anyway —
 * rewording what a user reads has to be a deliberate edit in two places.
 */
const OUTPUT_TRUNCATED_MESSAGE =
  "The model reached its output limit before completing this response.";

interface WireEvent {
  type: string;
  payload: Record<string, unknown>;
}

interface SseFrame {
  /** The SSE `id:` line, or null for a control frame that carries none. */
  id: number | null;
  event: WireEvent;
}

interface TextPart {
  kind: string;
  text?: string;
}

interface ChatMessageLike {
  role: string;
  parts: TextPart[];
}

interface TerminalFailure {
  code: string;
  message: string;
  retryable: boolean;
  backend: string;
  model: string;
}

interface ConversationRecordLike {
  messages: ChatMessageLike[];
  lastTurnFailure?: TerminalFailure;
  terminalFailure?: { code: string };
}

interface ResumeSnapshot {
  sessionId: string;
  busy: boolean;
  messages: ChatMessageLike[];
  eventCursor: number;
}

describe("agent event stream — resume cursor, truncated terminal, batch citations", () => {
  let harness: SyntheticE2EHarness;
  let db: Db;
  let fixtureDir: string;
  let docA = "";
  let docB = "";
  let docC = "";

  beforeAll(async () => {
    // Collapse the omnesis-chat upsert window so the conversation document
    // and its `cited` edges land right after the turn instead of 30s later.
    process.env.OMNESIS_CHAT_DEBOUNCE_MS = "0";

    fixtureDir = mkdtempSync(join(tmpdir(), "omnesis-agent-stream-fixture-"));
    writeCassette(
      fixtureDir,
      "batch-citations",
      {
        triggers: [TRIGGER_CITE],
        placeholders: { docExternalIds: [DOC_A_EXT, DOC_B_EXT, DOC_C_EXT] },
      },
      [
        entry("agent.message.start", { role: "assistant" }),
        entry("agent.text.delta", { delta: "Three documents ground this answer." }),
        // No matching `agent.tool.result`: the replay backend classifies this
        // call as LIVE and runs the real `annotate_many`, so `runBatch` builds
        // the three-item `annotate.batch` the fan-out under test consumes.
        entry("agent.tool.start", {
          toolCallId: "tc_batch",
          tool: "annotate_many",
          args: {
            annotations: [
              { documentId: `$DOC_${DOC_A_EXT}`, quote: QUOTE_A },
              { documentId: `$DOC_${DOC_B_EXT}`, note: NOTE_B },
              { documentId: `$DOC_${DOC_C_EXT}`, quote: QUOTE_C, quoteAuthor: QUOTE_C_AUTHOR },
            ],
          },
        }),
        entry("agent.text.delta", { delta: "That is the whole picture." }),
        entry("agent.message.end", { stopReason: "end_turn" }),
      ],
    );
    writeCassette(fixtureDir, "long-stream", { triggers: [TRIGGER_LONG] }, [
      entry("agent.message.start", { role: "assistant" }),
      entry("agent.text.delta", { delta: LONG_ANSWER }),
      entry("agent.message.end", { stopReason: "end_turn" }),
    ]);
    writeCassette(fixtureDir, "truncated", { triggers: [TRIGGER_TRUNCATE] }, [
      entry("agent.message.start", { role: "assistant" }),
      entry("agent.text.delta", { delta: PARTIAL_ANSWER }),
      entry("agent.message.end", { stopReason: "max_tokens" }),
    ]);
    process.env.OMNESIS_AGENT_FIXTURE = fixtureDir;

    // `agentBackend` stays at its "off" default so the harness leaves
    // OMNESIS_AGENT_FIXTURE alone; the assignment is what enables the agent.
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      extraInference: { assignments: { agent: "replay" } },
    });
    await harness.start();

    await harness.pushDocuments([
      { externalId: DOC_A_EXT, title: "Riverside project outline", content: QUOTE_A },
      { externalId: DOC_B_EXT, title: "Q4 budget note", content: "Quarterly allocation summary." },
      { externalId: DOC_C_EXT, title: "Rebuild vendor quote", content: QUOTE_C },
    ]);

    db = new Database(harness.getDbPath(), { readonly: true });
    const byExternalId = db.prepare<[string], { id: string }>(
      "SELECT id FROM documents WHERE external_id = ? LIMIT 1",
    );
    await waitForCondition(
      () => {
        const a = byExternalId.get(DOC_A_EXT);
        const b = byExternalId.get(DOC_B_EXT);
        const c = byExternalId.get(DOC_C_EXT);
        if (!a || !b || !c) return false;
        docA = a.id;
        docB = b.id;
        docC = c.id;
        return true;
      },
      BARRIER_TIMEOUT_MS,
      "the three cited documents to be readable in the gateway DB",
    );
  }, 240_000);

  afterAll(async () => {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
    await harness?.destroy();
    delete process.env.OMNESIS_AGENT_FIXTURE;
    delete process.env.OMNESIS_CHAT_DEBOUNCE_MS;
    rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  test(
    "one annotate_many call becomes one live citation, one terminal ref and one durable edge per document",
    async () => {
      const sessionId = await createSession(harness);
      const stream = await EventStream.open(harness);
      let frames: readonly SseFrame[];
      let messageId: string;
      try {
        messageId = await sendMessage(harness, sessionId, TRIGGER_CITE);
        frames = await stream.readUntil(
          (fs) => fs.some((f) => isTerminalFor(f, sessionId, messageId)),
          FRAME_TIMEOUT_MS,
          `agent.message.end for ${messageId}`,
        );
      } finally {
        await stream.close();
      }

      // Precondition: every child really was recorded. `annotate` drops an
      // errored child before the session indexes the survivors, so an
      // unresolved `$DOC_*` would renumber them and leave a mysterious count
      // instead of a readable `document_not_found`.
      const results = eventsOf(frames, "agent.tool.result", sessionId).filter(
        (e) => e.payload.toolCallId === "tc_batch",
      );
      expect(results).toHaveLength(1);
      const batch = results[0]!.payload.result as {
        kind: string;
        items: Array<Record<string, unknown>>;
      };
      expect(batch.kind).toBe("annotate.batch");
      expect(batch.items.map((i) => i.kind)).toEqual([
        "annotate.recorded",
        "annotate.recorded",
        "annotate.recorded",
      ]);

      // On the wire: one `agent.citation` per child, each with its own
      // `#idx`-suffixed id so a client renders three Timeline rows, not one.
      const citations = eventsOf(frames, "agent.citation", sessionId);
      expect(citations.map((e) => e.payload.toolCallId)).toEqual([
        "tc_batch#0",
        "tc_batch#1",
        "tc_batch#2",
      ]);
      expect(citations.map((e) => e.payload.documentId)).toEqual([docA, docB, docC]);
      // Per-child payloads are not smeared across the batch.
      expect(citations[0]!.payload.quote).toBe(QUOTE_A);
      expect(citations[0]!.payload.note).toBeUndefined();
      expect(citations[1]!.payload.note).toBe(NOTE_B);
      expect(citations[1]!.payload.quote).toBeUndefined();
      expect(citations[2]!.payload.quote).toBe(QUOTE_C);
      expect(citations[2]!.payload.quoteAuthor).toBe(QUOTE_C_AUTHOR);

      // The terminal snapshot carries the same three refs, and it arrives
      // before `agent.message.end` — so reading to the terminal captures it.
      const updates = eventsOf(frames, "agent.citations.update", sessionId);
      expect(updates).toHaveLength(1);
      const added = updates[0]!.payload.added as Array<{ documentId: string }>;
      expect(new Set(added.map((r) => r.documentId))).toEqual(new Set([docA, docB, docC]));

      // In the corpus: the conversation document, then three `cited` edges.
      const convRow = db.prepare<[string], { id: string }>(
        "SELECT id FROM documents WHERE source_id = 'omnesis-chat' AND external_id = ? LIMIT 1",
      );
      let convId = "";
      await waitForCondition(
        () => {
          const row = convRow.get(sessionId);
          if (!row) return false;
          convId = row.id;
          return true;
        },
        BARRIER_TIMEOUT_MS,
        `the omnesis-chat document for conversation ${sessionId}`,
      );

      // One statement, one snapshot: better-sqlite3 opens a fresh read
      // snapshot per statement, so counting and reading separately can
      // observe two different writer states.
      const citedRows = db.prepare<
        [string],
        { target_doc_id: string | null; normalized_target: string; metadata_json: string | null }
      >(
        "SELECT target_doc_id, normalized_target, metadata_json FROM document_links " +
          "WHERE source_doc_id = ? AND link_type = 'cited' ORDER BY id",
      );
      let edges: Array<{
        target_doc_id: string | null;
        normalized_target: string;
        metadata_json: string | null;
      }> = [];
      await waitForCondition(
        () => {
          const rows = citedRows.all(convId);
          if (rows.length !== 3) return false;
          edges = rows;
          return true;
        },
        BARRIER_TIMEOUT_MS,
        `three 'cited' edges from conversation document ${convId}`,
      );

      expect(edges.map((r) => r.target_doc_id)).toEqual([docA, docB, docC]);
      expect(new Set(edges.map((r) => r.normalized_target)).size).toBe(3);
      for (const row of edges) {
        expect(row.normalized_target).toMatch(/^omnesis:\/\/doc\/[0-9a-f-]+#\d+$/i);
      }
      const meta = edges.map((r) =>
        r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : {},
      );
      expect(meta[0]).toEqual({ quote: QUOTE_A });
      expect(meta[1]).toEqual({ note: NOTE_B });
      expect(meta[2]).toEqual({ quote: QUOTE_C, quoteAuthor: QUOTE_C_AUTHOR });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a turn that hits the output ceiling keeps its partial answer, names the failure honestly, and leaves the conversation writable",
    async () => {
      const sessionId = await createSession(harness);
      const stream = await EventStream.open(harness);
      let frames: readonly SseFrame[];
      let firstMessageId: string;
      let secondMessageId: string;
      try {
        firstMessageId = await sendMessage(harness, sessionId, TRIGGER_TRUNCATE);
        frames = await stream.readUntil(
          (fs) => fs.some((f) => isTerminalFor(f, sessionId, firstMessageId)),
          FRAME_TIMEOUT_MS,
          `agent.message.end for ${firstMessageId}`,
        );

        const terminal = frames.find((f) => isTerminalFor(f, sessionId, firstMessageId))!.event;
        expect(terminal.payload.stopReason).toBe("max_tokens");
        // The cassette carries no `failure`; the session's `max_tokens` arm
        // has to synthesise this whole object, including the vetted sentence.
        expect(terminal.payload.failure).toEqual({
          code: "output_truncated",
          message: OUTPUT_TRUNCATED_MESSAGE,
          retryable: false,
          backend: "replay",
          model: "replay",
        });

        // Truncation is a terminal failure with a vetted message, not an
        // error toast. Scoped to this turn: the follow-up below runs the
        // routing backend's exhausted stream, which does emit an
        // `agent.error` on the same session.
        expect(
          frames.filter(
            (f) =>
              f.event.type === "agent.error" &&
              f.event.payload.sessionId === sessionId &&
              f.event.payload.messageId === firstMessageId,
          ),
        ).toHaveLength(0);

        const afterFirst = await waitForRecord(
          harness,
          sessionId,
          (r) => lastAssistantText(r.messages).length > 0,
          "the truncated turn to persist",
        );
        // The half-written answer survives verbatim: nothing dropped by the
        // failure path, nothing appended by it.
        expect(lastAssistantText(afterFirst.messages)).toBe(PARTIAL_ANSWER);
        expect(afterFirst.lastTurnFailure).toEqual({
          code: "output_truncated",
          message: OUTPUT_TRUNCATED_MESSAGE,
          retryable: false,
          backend: "replay",
          model: "replay",
        });
        // The distinction that matters: `terminalFailure` freezes a
        // conversation, `lastTurnFailure` only marks a turn.
        expect(afterFirst.terminalFailure).toBeUndefined();
        const firstTurnMessageCount = afterFirst.messages.length;

        // The conversation is still writable — unlike its
        // `context_window_exceeded` sibling, which refuses the send with 409.
        secondMessageId = await sendMessage(harness, sessionId, "continue");
        expect(secondMessageId).toBeTruthy();
        await stream.readUntil(
          (fs) => fs.some((f) => isTerminalFor(f, sessionId, secondMessageId)),
          FRAME_TIMEOUT_MS,
          `agent.message.end for ${secondMessageId}`,
        );

        // The first record already answers 200, so re-polling for one gates
        // nothing. Gate on the transcript actually growing instead.
        const afterSecond = await waitForRecord(
          harness,
          sessionId,
          (r) => r.messages.length > firstTurnMessageCount,
          "the follow-up turn to persist",
        );
        expect(afterSecond.lastTurnFailure?.code).not.toBe("output_truncated");
      } finally {
        await stream.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a client that drops mid-turn and resumes at the snapshot cursor sees every event exactly once",
    async () => {
      const sessionId = await createSession(harness);
      const first = await EventStream.open(harness);
      let messageId: string;
      try {
        messageId = await sendMessage(harness, sessionId, TRIGGER_LONG);
        // Disconnect after a frame COUNT, never after an elapsed time.
        await first.readUntil(
          (fs) => {
            const mine = fs.filter((f) => f.id !== null && f.event.payload.sessionId === sessionId);
            return mine.length >= 8 && mine.some((f) => f.event.type === "agent.text.delta");
          },
          FRAME_TIMEOUT_MS,
          "eight sequenced frames including at least one text delta",
        );
      } finally {
        await first.close();
      }

      // The production hand-off: the resume snapshot mints the cursor next to
      // the history it belongs with, in the same synchronous statement pair.
      const snapshot = await resumeSession(harness, sessionId);
      const snapshotText = assistantText(snapshot.messages);
      const cursor = snapshot.eventCursor;
      expect(Number.isInteger(cursor)).toBe(true);

      const second = await EventStream.open(harness, cursor);
      let frames: readonly SseFrame[];
      try {
        frames = await second.readUntil(
          (fs) => fs.some((f) => isTerminalFor(f, sessionId, messageId)),
          FRAME_TIMEOUT_MS,
          `agent.message.end for ${messageId} on the resumed stream`,
        );
      } finally {
        await second.close();
      }

      // Nothing was lost: the gateway never asked this client to reload.
      expect(frames.filter((f) => f.event.type === "agent.resync")).toHaveLength(0);

      const sequenced = frames.filter((f) => f.id !== null);
      expect(sequenced.length).toBeGreaterThan(0);
      // The exact seam `subscribe` promises: replay resumes at cursor + 1…
      expect(sequenced[0]!.id).toBe(cursor + 1);
      // …and hands over to the live listener without a gap or a repeat.
      for (let i = 1; i < sequenced.length; i++) {
        expect(sequenced[i]!.id).toBe(sequenced[i - 1]!.id! + 1);
      }

      const deltasOnSecond = frames
        .filter(
          (f) =>
            f.event.type === "agent.text.delta" &&
            f.event.payload.sessionId === sessionId &&
            f.event.payload.messageId === messageId,
        )
        .map((f) => f.event.payload.delta as string)
        .join("");

      // Both halves must be real, or the comparison below degenerates into
      // "the persisted text equals the persisted text". Guaranteed by
      // construction: the disconnect happens after at least one delta, and
      // the cassette's ~8s tail is still ahead of the reconnect.
      expect(snapshotText.length).toBeGreaterThan(0);
      expect(deltasOnSecond.length).toBeGreaterThan(0);

      const record = await waitForRecord(
        harness,
        sessionId,
        (r) => lastAssistantText(r.messages).length > 0,
        "the long answer to persist",
      );
      // The answer a reconnecting client renders is the answer the gateway
      // stored — character for character, across the snapshot/stream seam.
      expect(snapshotText + deltasOnSecond).toBe(assistantText(record.messages));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a cursor ahead of the living sequence is refused with agent.resync, never aliased onto it",
    async () => {
      // Mint a LARGE cursor from a long turn, then restart. The restarted
      // process starts its sequence at 1 again, so a short turn leaves the
      // stale cursor ahead of everything the new process has assigned —
      // `replayFrom`'s reset arm, which no spawned gateway has ever taken.
      const before = await createSession(harness);
      await sendMessage(harness, before, TRIGGER_LONG);
      await waitForRecord(
        harness,
        before,
        (r) => lastAssistantText(r.messages).length > 0,
        "the pre-restart turn to persist",
      );
      const staleCursor = (await resumeSession(harness, before)).eventCursor;

      await harness.restartGateway();

      const after = await createSession(harness);
      await sendMessage(harness, after, TRIGGER_TRUNCATE);
      await waitForRecord(
        harness,
        after,
        (r) => lastAssistantText(r.messages).length > 0,
        "the post-restart turn to persist",
      );
      const postRestartMax = (await resumeSession(harness, after)).eventCursor;

      // The precondition that keeps this honest under fixture drift: with the
      // cursor BELOW the new sequence the gateway would legitimately replay,
      // and the assertion below would be testing the wrong branch.
      expect(staleCursor).toBeGreaterThan(postRestartMax);

      const stream = await EventStream.open(harness, staleCursor);
      try {
        const frames = await stream.readUntil(
          (fs) => fs.length > 0,
          FRAME_TIMEOUT_MS,
          "the first data frame on a stream resumed from a stale cursor",
        );
        // A sequence number is only meaningful inside the sequence that
        // minted it: a cursor ahead of ours is refused, never interpreted as
        // a position in the living one.
        expect(frames[0]!.event.type).toBe("agent.resync");
        // Seq 0 is reserved for control events with no resumable position,
        // so the frame carries no `id:` line for the client to hold on to.
        expect(frames[0]!.id).toBeNull();
      } finally {
        await stream.close();
      }
    },
    RESTART_TEST_TIMEOUT_MS,
  );
});

// ─── cassette authoring ───────────────────────────────────────────────────

/**
 * One fixture line. `$SESSION` / `$MSG` are substituted at emit time; both
 * are required by the payload schemas `parseFixture` validates at LOAD time,
 * and a miss is swallowed into an `agent disabled: Replay fixture failed to
 * load: …` that reads as a broken suite rather than a broken fixture.
 */
function entry(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    afterMs: 0,
    event: { type, payload: { sessionId: "$SESSION", messageId: "$MSG", ...payload } },
  });
}

/** Write one `<name>.jsonl` + `<name>.meta.json` pair into a fixture directory. */
function writeCassette(
  dir: string,
  name: string,
  meta: { triggers: string[]; placeholders?: { docExternalIds: string[] } },
  entries: string[],
): void {
  writeFileSync(join(dir, `${name}.jsonl`), `${entries.join("\n")}\n`);
  // The meta schema is `.strict()` — only triggers / role / placeholders.
  writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify(meta));
}

// ─── HTTP drivers ─────────────────────────────────────────────────────────

async function createSession(h: SyntheticE2EHarness): Promise<string> {
  const created = await h.gatewayJson<{ sessionId: string }>("/agent/sessions", {
    method: "POST",
    body: "{}",
  });
  return created.sessionId;
}

async function resumeSession(h: SyntheticE2EHarness, sessionId: string): Promise<ResumeSnapshot> {
  return h.gatewayJson<ResumeSnapshot>("/agent/sessions", {
    method: "POST",
    body: JSON.stringify({ resumeFromId: sessionId }),
  });
}

async function sendMessage(
  h: SyntheticE2EHarness,
  sessionId: string,
  text: string,
): Promise<string> {
  const sent = await h.gatewayJson<{ messageId: string }>(`/agent/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  return sent.messageId;
}

/**
 * Poll the persisted conversation until it satisfies `pred`. The route reads
 * the store only, so what it returns is a durable barrier — but the FIRST
 * turn's record makes it answer 200 forever after, which is why every caller
 * passes a predicate over the record's shape rather than "does it 200".
 */
async function waitForRecord(
  h: SyntheticE2EHarness,
  sessionId: string,
  pred: (record: ConversationRecordLike) => boolean,
  label: string,
): Promise<ConversationRecordLike> {
  let latest: ConversationRecordLike | undefined;
  await waitForCondition(
    async () => {
      const res = await h.gatewayFetch(`/agent/conversations/${sessionId}`);
      if (!res.ok) {
        await res.text();
        return false;
      }
      const record = (await res.json()) as ConversationRecordLike;
      if (!pred(record)) return false;
      latest = record;
      return true;
    },
    BARRIER_TIMEOUT_MS,
    label,
  );
  return latest!;
}

// ─── SSE plumbing ─────────────────────────────────────────────────────────

function isTerminalFor(frame: SseFrame, sessionId: string, messageId: string): boolean {
  return (
    frame.event.type === "agent.message.end" &&
    frame.event.payload.sessionId === sessionId &&
    frame.event.payload.messageId === messageId
  );
}

function eventsOf(
  frames: readonly SseFrame[],
  type: string,
  sessionId: string,
): readonly WireEvent[] {
  return frames
    .filter((f) => f.event.type === type && f.event.payload.sessionId === sessionId)
    .map((f) => f.event);
}

/** Concatenate every assistant `text` part of a transcript, in order. */
function assistantText(messages: readonly ChatMessageLike[]): string {
  return messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts)
    .filter((p) => p.kind === "text")
    .map((p) => p.text ?? "")
    .join("");
}

/** Assistant text of the last assistant message only. */
function lastAssistantText(messages: readonly ChatMessageLike[]): string {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return last ? assistantText([last]) : "";
}

/**
 * Error-recovery backoff. Used only when opening `/agent/events` is refused,
 * which happens when the per-caller listener cap (4, with no config knob) is
 * still holding a listener whose connection is gone — the gateway reaps those
 * on its 25s heartbeat and there is no way to shorten either number. Never a
 * synchronization point for an assertion: every wait this file depends on is
 * condition-gated.
 */
function recoveryBackoff(): Promise<void> {
  return new Promise((r) => setTimeout(r, 1_000));
}

const decoder = new TextDecoder();

/**
 * One `/agent/events` connection, parsed into frames that keep the `id:` line
 * the other suites' readers discard — the resume seam is expressed entirely
 * in those ids. Connections are never overlapped: each is closed before the
 * next is opened, so at most one lives against the per-caller cap.
 */
class EventStream {
  private readonly frames: SseFrame[] = [];
  private buffer = "";
  private ended = false;

  private constructor(
    private readonly ac: AbortController,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}

  static async open(h: SyntheticE2EHarness, lastEventId?: number): Promise<EventStream> {
    let lastFailure = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const ac = new AbortController();
      const res = await fetch(`${h.gatewayUrl}/agent/events`, {
        headers: {
          Authorization: `Bearer ${h.apiKey}`,
          Accept: "text/event-stream",
          ...(lastEventId !== undefined ? { "Last-Event-ID": String(lastEventId) } : {}),
        },
        signal: ac.signal,
      });
      if (res.ok && res.body) return new EventStream(ac, res.body.getReader());
      // A listener-cap breach throws inside the ReadableStream constructor,
      // which surfaces as a non-2xx rather than an errored body.
      lastFailure = `${res.status}: ${await res.text()}`;
      ac.abort();
      await recoveryBackoff();
    }
    throw new Error(`GET /agent/events never opened — last response ${lastFailure}`);
  }

  /**
   * Read until `pred` holds over everything seen so far, then return a
   * snapshot of it — a copy, so a caller holding an earlier result is not
   * silently re-scoped by a later read on the same connection. `timeoutMs`
   * bounds a stalled stream; it is never the thing being waited on — the
   * predicate is.
   */
  async readUntil(
    pred: (frames: readonly SseFrame[]) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<readonly SseFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (!pred(this.frames)) {
      if (this.ended) {
        throw new Error(`SSE stream ended before ${label} (${this.summary()})`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.pump(remaining, label);
    }
    if (!pred(this.frames)) {
      throw new Error(`Timed out waiting for ${label} (${this.summary()})`);
    }
    return [...this.frames];
  }

  private async pump(timeoutMs: number, label: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), timeoutMs);
    });
    try {
      const next = await Promise.race([this.reader.read(), expiry]);
      if (next === "expired") {
        throw new Error(`Timed out waiting for ${label} (${this.summary()})`);
      }
      if (next.done) {
        this.ended = true;
        return;
      }
      this.ingest(decoder.decode(next.value, { stream: true }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const split = this.buffer.indexOf("\n\n");
      if (split === -1) return;
      const block = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      let id: number | null = null;
      let data: string | null = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) id = Number(line.slice(4));
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      // Comment-only blocks are the keep-alive heartbeat — no event.
      if (data === null) continue;
      this.frames.push({ id, event: JSON.parse(data) as WireEvent });
    }
  }

  private summary(): string {
    return `saw ${this.frames.length} frame(s): ${this.frames
      .slice(-6)
      .map((f) => f.event.type)
      .join(", ")}`;
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      /* the stream may already be errored or done */
    }
    this.ac.abort();
  }
}
