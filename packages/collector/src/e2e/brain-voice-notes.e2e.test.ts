// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Quick captures become real source-maintenance work. Pending transcription
 * blocks interpretation until the gateway's final text is available. The fixture
 * parks an earlier retry deterministically rather than racing the transcriber;
 * typed notes are the control and the model remains the scripted bench puppet.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  sourceInterpretations,
  preserveCurrentOwner,
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

let bench: BrainBench;

beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    // No scripted behavior: the puppet fetches each run's document, then
    // finishes. The fetch is what the agent was handed, and all this suite reads.
    brain: { knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 } },
    behaviors: {
      dynamic: sourceInterpretations({
        sources: [{ plan: { calls: [] } }],
        maintainNode: preserveCurrentOwner,
      }),
    },
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

/** The document text the agent was handed: its run's `fetch_many` result. */
async function fetchedContent(runId: string): Promise<string> {
  const tools: ExecutedTool[] = await bench.obs.executedTools(runId);
  const fetches = tools.filter((t) => t.tool === "fetch_many");
  expect(fetches.length).toBeGreaterThan(0);
  return fetches.map((t) => JSON.stringify(t.result)).join("\n");
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

    const runs = await bench.obs.runsForSource(docId);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run!.status).toBe("completed");
    expect(run!.kind).toBe("synthesis");
    expect(
      bench.sql
        .prepare(
          "SELECT 1 FROM knowledge_work WHERE subject_id=? AND last_error='pending_content' AND status='pending'",
        )
        .get(docId),
    ).toBeUndefined();
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
    const runsBefore = (await bench.obs.runsForSource(docId)).length;

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

    // Pending content remains in the durable intake buffer, before any source batch is bought.
    const held = await waitFor(
      "a source waiting on pending voice content",
      () =>
        bench.sql
          .prepare<
            [string],
            { id: string; due_at: number }
          >("SELECT id,due_at FROM knowledge_work WHERE subject_id=? AND status='pending' AND last_error='pending_content'")
          .get(docId) ?? null,
      30_000,
    );
    expect(await bench.obs.runsForSource(docId)).toHaveLength(runsBefore);
    expect(held.id).toBeTruthy();
    // The earlier note's transcription is given up on: nothing on the document
    // is pending any more, so the readiness pass releases the parked run.
    bench.withWriteHandle((db) => {
      db.prepare("DELETE FROM voice_note_transcriptions WHERE note_id = ?").run(TYPED_ID);
    });
    await bench.drainUntilQuiet();

    const runs = await bench.obs.runsForSource(docId);
    expect(runs).toHaveLength(runsBefore + 1);
    const run = runs[0]!;
    expect(run.status).toBe("completed");
    const content = await fetchedContent(run.id);
    expect(content).toContain(SPOKEN);
    expect(content).not.toContain(DEVICE_TEXT);
    expect(
      bench.sql
        .prepare("SELECT 1 FROM knowledge_work WHERE id=? AND status IN ('pending','batched')")
        .get(held.id),
    ).toBeUndefined();
  }, 180_000);

  test("a typed note after the hold is again read at once", async () => {
    const before = (await bench.obs.runsForSource(docId)).length;
    await captureTypedNote(randomUUID(), "Return the library books on Monday.");
    // The capture reaches the corpus through the notes day's debounced
    // projection; drain only once it has, or the wake may not exist yet.
    await dayDocumentContains("Return the library books on Monday.");
    await bench.drainUntilQuiet();

    const runs = await bench.obs.runsForSource(docId);
    expect(runs).toHaveLength(before + 1);
    const run = runs[0]!;
    expect(run.status).toBe("completed");
    expect(run.kind).toBe("synthesis");
  }, 120_000);
});
