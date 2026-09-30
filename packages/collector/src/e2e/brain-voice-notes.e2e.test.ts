// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain bench: a quick-capture voice note is read once, in the gateway's words.
 *
 * A voice note lands in the omnesis-notes day document at once, carrying the
 * device's own transcript, and the gateway's transcriber replaces that text a
 * little later. The note is addressed to the agent, so its `data` run would
 * normally be claimed straight away — and would reason over the device's rough
 * transcript first and the gateway's transcript second. The waker's readiness
 * hold prevents that: while the day document still holds a voice note waiting
 * on the transcriber, its run is parked (up to `brain.pendingContentBarrier`),
 * the transcript's update folds into that parked run, and the run is released
 * once nothing on the document is waiting any more.
 *
 * The bench runs the synthetic transcriber, which answers at once, so the
 * pending state is arranged deterministically instead of raced: before the
 * voice note is sent, the day's earlier note is given a queued transcription
 * with a retry due hours out — the row a voice note waiting on its retry
 * backoff leaves behind. That keeps the day document pending after the new
 * note's own transcript lands, so the test can see the run parked with the
 * transcript already folded in, then release it by removing the row (what a
 * give-up does) and read what the agent was handed.
 *
 * A typed note is the control: no transcription is ever pending for it, so its
 * run is claimed at once with no hold.
 *
 * Every note is invented; the model is the bench's puppet (no inference).
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  compressCognitionCadences,
  waitFor,
  type ExecutedTool,
} from "./brain-bench/index.js";

compressCognitionCadences();

/** One capture instant for every note, in UTC, so all of them share one day document. */
const CAPTURED_AT = new Date().toISOString();
const DAY = CAPTURED_AT.slice(0, 10);
const CAPTURE_ZONE = { capturedTimeZoneId: "UTC", capturedUtcOffsetSeconds: 0 } as const;

const TYPED_ID = randomUUID();
const TYPED_TEXT = "Water the ferns on the balcony before the weekend.";

const VOICE_ID = randomUUID();
/** What the phone's own recogniser made of the recording. */
const DEVICE_TEXT = "pick up the dry cleaning buy fore stamps";
/** What was said — the synthetic transcriber returns the audio bytes as the transcript. */
const SPOKEN = "Pick up the dry cleaning and buy four stamps.";

/** The pending-content hold's shipped ceiling — the bench leaves it at its default. */
const PENDING_CONTENT_BARRIER_MS = 60 * 60_000;

interface RunRow {
  id: string;
  status: string;
  next_attempt_at: number;
  enqueued_at: number;
  payload_json: string;
}

interface DataRunPayload {
  event: "created" | "updated";
  immediate?: boolean;
  diff?: string;
  barrierUntil?: number;
}

let bench: BrainBench;

beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    // No scripted behavior: the puppet fetches each run's document, then
    // finishes. The fetch is what the agent was handed, and all this suite reads.
    behaviors: {},
    extraInference: { assignments: { transcriber: "replay" } },
  });
}, 300_000);

afterAll(async () => {
  await bench?.destroy();
}, 60_000);

// ── helpers ─────────────────────────────────────────────────────────────────

async function captureTypedNote(id: string, text: string): Promise<void> {
  const res = await bench.harness.gatewayFetch("/notes", {
    method: "POST",
    body: JSON.stringify({ id, text, capturedAt: CAPTURED_AT, ...CAPTURE_ZONE }),
  });
  expect(res.status).toBe(201);
}

async function sendVoiceNote(id: string, deviceText: string, spoken: string): Promise<void> {
  const form = new FormData();
  form.set(
    "note",
    JSON.stringify({
      id,
      text: deviceText,
      language: "en-GB",
      surface: "ios-app",
      capturedAt: CAPTURED_AT,
      ...CAPTURE_ZONE,
    }),
  );
  form.set("audio", new Blob([new TextEncoder().encode(spoken)], { type: "audio/mp4" }), "n.m4a");
  // Encode the form first: the harness defaults a bodied request without a
  // Content-Type to JSON, which would drop the multipart boundary.
  const encoded = new Response(form);
  const res = await bench.harness.gatewayFetch("/notes/voice", {
    method: "POST",
    headers: { "Content-Type": encoded.headers.get("content-type")! },
    body: await encoded.arrayBuffer(),
  });
  expect(res.status).toBe(202);
}

async function listedNote(
  id: string,
): Promise<{ id: string; text: string; transcription?: string } | undefined> {
  const { entries } = await bench.harness.gatewayJson<{
    entries: Array<{ id: string; text: string; transcription?: string }>;
  }>(`/notes?day=${DAY}`);
  return entries.find((entry) => entry.id === id);
}

/** The day's notes document, once the capture has projected it. */
function notesDocId(): Promise<string> {
  return waitFor(
    `the notes document for ${DAY}`,
    () =>
      bench.sql
        .prepare<
          [string],
          { id: string }
        >("SELECT id FROM documents WHERE source_id = 'omnesis-notes' AND external_id = ?")
        .get(DAY)?.id ?? null,
    30_000,
  );
}

/** Wait until the day's notes document carries `text` (its debounced projection landed). */
function dayDocumentContains(text: string): Promise<true> {
  return waitFor(
    `the notes document to contain "${text}"`,
    () =>
      (bench.sql
        .prepare<
          [string],
          { content: string }
        >("SELECT content FROM documents WHERE source_id = 'omnesis-notes' AND external_id = ?")
        .get(DAY)
        ?.content.includes(text) ?? false)
        ? true
        : null,
    30_000,
  );
}

/** Every `data` run the notes document has had, oldest first. */
function dataRuns(docId: string): RunRow[] {
  return bench.sql
    .prepare<[string], RunRow>(
      `SELECT id, status, next_attempt_at, enqueued_at, payload_json
         FROM cognition_runs WHERE kind = 'data' AND dedupe_key = ?
        ORDER BY enqueued_at, rowid`,
    )
    .all(`data:doc:${docId}`);
}

function payloadOf(run: RunRow): DataRunPayload {
  return JSON.parse(run.payload_json) as DataRunPayload;
}

/** The document text the agent was handed: its run's `fetch_many` result. */
async function fetchedContent(runId: string): Promise<string> {
  const tools: ExecutedTool[] = await bench.obs.executedTools(runId);
  const fetches = tools.filter((t) => t.tool === "fetch_many");
  expect(fetches.length).toBeGreaterThan(0);
  return fetches.map((t) => JSON.stringify(t.result)).join("\n");
}

function waitForStatus(runId: string, status: string): Promise<RunRow> {
  return waitFor(
    () => `run ${runId} to reach ${status} (now ${String(bench.runRow(runId)?.status)})`,
    () => {
      const row = bench.runRow(runId) as unknown as RunRow | undefined;
      return row?.status === status ? row : null;
    },
    60_000,
  );
}

// ── the suite ───────────────────────────────────────────────────────────────

describe("voice notes and the Brain's readiness hold (brain bench)", () => {
  let docId: string;

  test("boot leaves the engine idle, and gateway dictation is active", async () => {
    await bench.drainUntilQuiet();
    expect((await bench.obs.runs({ kind: "data" })).items).toHaveLength(0);
    const { dictation } = await bench.harness.gatewayJson<{ dictation: { active: boolean } }>(
      "/status",
    );
    expect(dictation.active).toBe(true);
  }, 120_000);

  test("a typed note is read at once, with no hold", async () => {
    await captureTypedNote(TYPED_ID, TYPED_TEXT);
    docId = await notesDocId();
    await bench.drainUntilQuiet();

    const runs = dataRuns(docId);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run!.status).toBe("completed");
    const payload = payloadOf(run!);
    expect(payload).toMatchObject({ event: "created", immediate: true });
    // Nothing on the document was waiting on a transcriber, so no barrier
    // pushed the run out: it was due the moment it was enqueued.
    expect(payload.barrierUntil).toBeUndefined();
    expect(await fetchedContent(run!.id)).toContain(TYPED_TEXT);
  }, 120_000);

  test("a voice note is held until the gateway's transcript lands, then read once, in the gateway's words", async () => {
    // The day's earlier note is waiting on a transcription retry, hours out.
    bench.withWriteHandle((db) => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO voice_note_transcriptions
           (note_id, audio, mime_type, language, saved_text, placeholder, attempts, next_attempt_at, created_at)
         VALUES (?, ?, 'audio/mp4', 'en', ?, 0, 1, ?, ?)`,
      ).run(
        TYPED_ID,
        Buffer.from(TYPED_TEXT, "utf8"),
        TYPED_TEXT,
        new Date(now + 6 * 60 * 60_000).toISOString(),
        new Date(now).toISOString(),
      );
    });
    const runsBefore = dataRuns(docId).length;

    await sendVoiceNote(VOICE_ID, DEVICE_TEXT, SPOKEN);

    // The gateway transcribes the new note and replaces the device's text.
    await waitFor(
      "the voice note's gateway transcript",
      async () => {
        const note = await listedNote(VOICE_ID);
        return note?.text === SPOKEN && note.transcription === undefined ? note : null;
      },
      30_000,
    );

    // Its run is parked, with the transcript's update folded into it: one
    // pending run whose diff already carries the gateway's words and never the
    // device's.
    const held = await waitFor(
      () => `a held data run carrying the transcript (runs: ${JSON.stringify(dataRuns(docId))})`,
      () => {
        const pending = dataRuns(docId).filter((r) => r.status === "pending");
        const run = pending.length === 1 ? pending[0]! : null;
        return run && payloadOf(run).diff?.includes(SPOKEN) ? run : null;
      },
      30_000,
    );
    expect(dataRuns(docId)).toHaveLength(runsBefore + 1);
    const heldPayload = payloadOf(held);
    expect(heldPayload.event).toBe("updated");
    expect(heldPayload.immediate).toBe(true);
    expect(heldPayload.diff).not.toContain(DEVICE_TEXT);
    // Held by the pending-content barrier: due at the barrier deadline, an hour
    // out, not at once as an addressed document otherwise is.
    expect(heldPayload.barrierUntil).toBeDefined();
    expect(held.next_attempt_at).toBe(heldPayload.barrierUntil);
    expect(held.next_attempt_at).toBeGreaterThan(Date.now() + PENDING_CONTENT_BARRIER_MS / 2);
    expect(bench.puppetCalls.filter((c) => c.runId === held.id)).toHaveLength(0);

    // The earlier note's transcription is given up on: nothing on the document
    // is pending any more, so the readiness pass releases the parked run.
    bench.withWriteHandle((db) => {
      db.prepare("DELETE FROM voice_note_transcriptions WHERE note_id = ?").run(TYPED_ID);
    });
    await waitForStatus(held.id, "completed");
    await bench.drainUntilQuiet();

    // One run for the voice note, and it read the gateway's transcript only.
    const runs = dataRuns(docId);
    expect(runs).toHaveLength(runsBefore + 1);
    expect(runs.at(-1)!.id).toBe(held.id);
    expect(bench.puppetCalls.filter((c) => c.runId === held.id).length).toBeGreaterThan(0);
    const content = await fetchedContent(held.id);
    expect(content).toContain(SPOKEN);
    expect(content).not.toContain(DEVICE_TEXT);
    const prompt = await bench.obs.promptFor(held.id);
    expect(prompt).not.toContain(DEVICE_TEXT);
  }, 180_000);

  test("a typed note after the hold is again read at once", async () => {
    const before = dataRuns(docId).length;
    await captureTypedNote(randomUUID(), "Return the library books on Monday.");
    // The capture reaches the corpus through the notes day's debounced
    // projection; drain only once it has, or the wake may not exist yet.
    await dayDocumentContains("Return the library books on Monday.");
    await bench.drainUntilQuiet();

    const runs = dataRuns(docId);
    expect(runs).toHaveLength(before + 1);
    const run = runs.at(-1)!;
    expect(run.status).toBe("completed");
    expect(payloadOf(run).barrierUntil).toBeUndefined();
  }, 120_000);
});
