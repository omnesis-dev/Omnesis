// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — area A: the waker and the `data` runs it produces.
 *
 * The waker is the engine's front door: it decides which document events
 * are worth a cognition run, how long to wait before running one, and what
 * the run is told about what changed. This file pins that contract
 * end-to-end against a real gateway — arrival, update-with-diff, the
 * trailing debounce fold, the eligibility skips, the addressed-to-agent
 * fast path, a document deleted out from under an enqueued run, and the
 * backfill immunity that keeps an ambient corpus from waking anything.
 *
 * Everything here is invented: fictional people on RFC-2606 reserved
 * domains and a fictional vendor.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  CAST,
  addressedToAgent,
  bulkMail,
  call,
  compressCognitionCadences,
  email,
  note,
  sleep,
  waitFor,
  type BenchDoc,
  type RunDto,
} from "./brain-bench/index.js";

compressCognitionCadences();

/**
 * The per-document update debounce this bench runs with. Long enough that
 * a burst of edits spread over ~3s demonstrably folds into one run with
 * margin to spare on a loaded box, and that an addressed-to-agent update can
 * be shown to beat it; short enough that the tests still finish in seconds
 * and that `drainUntilQuiet` still reads a debounced run as imminent rather
 * than as deliberately parked.
 */
const UPDATE_DEBOUNCE_MS = 12_000;

// ── stimuli ─────────────────────────────────────────────────────────────────

const ARRIVAL = email({
  externalId: "waker-arrival",
  title: "Rehearsal slot for the autumn showcase",
  content:
    "Hi Alex,\n\nWe can hold the Thursday rehearsal slot for the autumn showcase.\nConfirm by Friday and the room is yours.\n\nStudio Northstar",
});

const EDITED = email({
  externalId: "waker-edited",
  title: "Catering order for the autumn showcase",
  content:
    "Hi Alex,\n\nHere is the catering order for the autumn showcase.\nHeadcount: forty guests.\nWe will invoice after the event.\n\nStellar Sound",
});
const EDITED_V2 =
  "Hi Alex,\n\nHere is the catering order for the autumn showcase.\nHeadcount: fifty-five guests.\nWe will invoice after the event.\n\nStellar Sound";

const BURST = note({
  externalId: "waker-burst",
  title: "Packing list for the autumn showcase",
  content:
    "Packing list for the autumn showcase.\nStatus: draft one.\nBring the stands and the cable reels.",
});
const burstBody = (revision: string): string =>
  `Packing list for the autumn showcase.\nStatus: draft ${revision}.\nBring the stands and the cable reels.`;

const ELIGIBLE = email({
  externalId: "waker-eligible",
  title: "Van hire quote for the autumn showcase",
  content:
    "Hi Alex,\n\nThe van hire quote for the autumn showcase is attached.\nLet us know if you want the larger vehicle.\n\nStellar Sound",
});

/**
 * Bulk marketing mail. The `bulkMail()` builder writes the header-shaped
 * fields a mail provider normalizes FROM (`listUnsubscribe`, `precedence`),
 * but the waker's gate reads the normalized `metadata.bulkMail` marker that
 * `defineSource` contract carries — the harness pushes metadata verbatim,
 * so the marker is supplied here explicitly.
 */
const BULK = bulkMail({
  externalId: "waker-bulk",
  title: "Spring offers from Stellar Sound",
  metadata: { bulkMail: true },
});

/** Backfilled history: a source timestamp far outside the recency window. */
const STALE = email({
  externalId: "waker-stale",
  title: "Archived invoice from Stellar Sound",
  content:
    "Hi Alex,\n\nThis is the archived invoice for last season's hire.\nIt was settled in full at the time.\n\nStellar Sound",
  ageDays: 60,
});

const ADDRESSED = addressedToAgent({
  externalId: "waker-addressed",
  title: "Note to the assistant about the autumn showcase",
  content: `Remember that ${CAST.maya.name} is running front of house for the autumn showcase.\nStatus: first pass.`,
});
const ADDRESSED_V2 = `Remember that ${CAST.maya.name} is running front of house for the autumn showcase.\nStatus: second pass, she also handles the guest list.`;

const DOOMED = email({
  externalId: "waker-doomed",
  title: "Draft rider for the autumn showcase",
  content:
    "Hi Alex,\n\nHere is the draft rider for the autumn showcase.\nRevision: one.\nSend back any changes.\n\nStudio Northstar",
});
const DOOMED_V2 =
  "Hi Alex,\n\nHere is the draft rider for the autumn showcase.\nRevision: two.\nSend back any changes.\n\nStudio Northstar";

// ── local probes ────────────────────────────────────────────────────────────

const dedupeKeyFor = (docId: string): string => `data:doc:${docId}`;

/**
 * Every `data` run — settled or not — folded on one document's key.
 *
 * `obs.runForDoc` serves the ONE run a document drove; this suite is about the
 * fold itself, so it needs the whole list (two transitions on one key), and it
 * needs an empty list rather than a throw for a document the waker declined.
 */
async function dataRunsFor(bench: BrainBench, docId: string): Promise<RunDto[]> {
  const page = await bench.obs.runs({ kind: "data" });
  return page.items.filter((r) => r.dedupeKey === dedupeKeyFor(docId));
}

/**
 * Wait for a document's `data` runs to settle.
 *
 * `drainUntilQuiet` alone is not enough here: the pulse counts a run as
 * queued only once `next_attempt_at` has arrived, so a run still inside its
 * debounce window reads as a quiet engine. This waits for the run to exist
 * and settle first, then drains, then re-reads.
 */
async function settleDataRuns(
  bench: BrainBench,
  docId: string,
  count: number,
  timeoutMs = 60_000,
): Promise<RunDto[]> {
  let seen = "(none)";
  await waitFor(
    () => `${count} settled data run(s) for ${docId}; last seen ${seen}`,
    async () => {
      const rows = await dataRunsFor(bench, docId);
      seen = rows.map((r) => `${r.status}(next=${r.nextAttemptAt ?? "-"})`).join(", ") || "(none)";
      const settled = rows.filter((r) => r.status !== "pending");
      return settled.length >= count ? settled : null;
    },
    timeoutMs,
  );
  await bench.drainUntilQuiet();
  return (await dataRunsFor(bench, docId)).filter((r) => r.status !== "pending");
}

/** Distinct run ids the puppet was asked to act on for one document. */
function puppetRunIdsFor(bench: BrainBench, docId: string, flavour: string): string[] {
  const ids = new Set<string>();
  for (const c of bench.puppetCalls) {
    if (c.subject === docId && c.flavour === flavour && c.runId) ids.add(c.runId);
  }
  return [...ids];
}

/** A document really landed in the corpus (the non-vacuity check for skips). */
function documentRow(bench: BrainBench, doc: BenchDoc): { id: string; title: string } | undefined {
  return bench.sql
    .prepare<
      [string],
      { id: string; title: string }
    >("SELECT id, title FROM documents WHERE external_id = ?")
    .get(doc.externalId);
}

// ── the bench ───────────────────────────────────────────────────────────────

describe("Brain waker — datum runs", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      brain: {
        // Long enough to observe the trailing debounce fold, and to prove
        // the addressed-to-agent fast path beats it.
        documentUpdateDebounce: `${UPDATE_DEBOUNCE_MS}ms`,
        conversationDebounce: `${UPDATE_DEBOUNCE_MS}ms`,
      },
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: ARRIVAL.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: "autumn showcase rehearsal" }),
                call("open_loop_create", {
                  title: "Confirm the rehearsal slot for the autumn showcase",
                  description: "The room is held until Friday.",
                  confidence: 0.9,
                  importance: 0.7,
                  docs: [ctx.subject],
                }),
              ],
              finalText: "Tracked the rehearsal confirmation.",
            }),
          },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("boot and a full universe sync wake nothing — backfill immunity", async () => {
    const status = await bench.obs.status();
    expect(status.briefs.modelAssigned).toBe(true);
    expect(status.briefs.active).toBe(true);

    // Not vacuous: the ambient corpus really landed. Its fixtures are dated
    // outside the recency window, so every one of them is backfill the
    // waker must consciously decline.
    const docs = bench.sql.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM documents").get();
    expect(docs?.n ?? 0).toBeGreaterThanOrEqual(10);

    const runs = await bench.obs.runs({ kind: "data" });
    expect(runs.items).toHaveLength(0);
    expect((await bench.obs.pulse()).counts.failedRuns24h).toBe(0);
  }, 60_000);

  test("a new eligible document drives exactly one settled data run", async () => {
    const [docId] = await bench.pushAndSettle([ARRIVAL]);
    const runs = await settleDataRuns(bench, docId!, 1);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completed");
    expect(runs[0]!.dedupeKey).toBe(dedupeKeyFor(docId!));

    // The puppet saw it as an arrival, not an update.
    expect(puppetRunIdsFor(bench, docId!, "data.created")).toEqual([runs[0]!.id]);
    expect(puppetRunIdsFor(bench, docId!, "data.updated")).toEqual([]);

    // And the run is visible on the decision surface, attributed to the doc.
    const decisions = await bench.obs.decisions({ doc: docId! });
    expect(decisions.items).toHaveLength(1);
    const decision = decisions.items[0]!;
    expect(decision.runId).toBe(runs[0]!.id);
    expect(decision.kind).toBe("data");
    expect(decision.docId).toBe(docId!);
    expect(decision.actions.map((a) => a.tool)).toContain("open_loop_create");
    expect(decision.actions.every((a) => a.ok)).toBe(true);
  }, 120_000);

  test("an update carries a diff and folds onto the document's dedupe key", async () => {
    const [docId] = await bench.pushAndSettle([EDITED]);
    const created = await settleDataRuns(bench, docId!, 1);
    expect(created).toHaveLength(1);

    await bench.update(EDITED, EDITED_V2);
    const runs = await settleDataRuns(bench, docId!, 2);

    // Two runs, one per transition — and both are the SAME queue identity:
    // the waker never mints a second fold key for a document.
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((r) => r.dedupeKey))).toEqual(new Set([dedupeKeyFor(docId!)]));
    expect(runs.every((r) => r.status === "completed")).toBe(true);

    const updateRunIds = puppetRunIdsFor(bench, docId!, "data.updated");
    expect(updateRunIds).toHaveLength(1);

    expect(await bench.obs.promptFor(updateRunIds[0]!)).toContain(
      `Document ${docId!} was updated.`,
    );
    const diff = await bench.obs.diffFor(updateRunIds[0]!);
    expect(diff).not.toBeNull();
    expect(diff).toContain("-Headcount: forty guests.");
    expect(diff).toContain("+Headcount: fifty-five guests.");

    // The arrival run, by contrast, is diff-free: the document was new.
    const createdRunId = puppetRunIdsFor(bench, docId!, "data.created")[0]!;
    expect(await bench.obs.diffFor(createdRunId)).toBeNull();
  }, 120_000);

  test("a burst of rapid edits folds into a single debounced run", async () => {
    const [docId] = await bench.pushAndSettle([BURST]);
    expect(await settleDataRuns(bench, docId!, 1)).toHaveLength(1);

    // Four edits spanning ~2.8s of a 12s window, so every one of them re-arms
    // the trailing timer on the SAME pending row and the fold still holds with
    // seconds to spare when the box is busy.
    for (const revision of ["two", "three", "four", "five"]) {
      await bench.update(BURST, burstBody(revision));
      await sleep(700);
    }

    const runs = await settleDataRuns(bench, docId!, 2);
    const updateRunIds = puppetRunIdsFor(bench, docId!, "data.updated");
    expect(updateRunIds).toHaveLength(1);
    expect(runs).toHaveLength(2);

    // One run, whose diff spans the whole burst: it is based on the body as
    // of the FIRST edit and targets the body as of the LAST.
    const diff = await bench.obs.diffFor(updateRunIds[0]!);
    expect(diff).not.toBeNull();
    expect(diff).toContain("-Status: draft one.");
    expect(diff).toContain("+Status: draft five.");
    expect(diff).not.toContain("draft three");

    // Nothing lingers behind the fold.
    const pulse = await bench.obs.pulse();
    expect(pulse.counts.queuedRuns).toBe(0);
    expect(pulse.counts.failedRuns24h).toBe(0);
  }, 120_000);

  test("bulk mail and backfilled history are skipped while a normal doc in the same batch wakes", async () => {
    await bench.pushAll([BULK, STALE, ELIGIBLE]);
    const eligibleId = await bench.docId(ELIGIBLE.externalId);
    expect(await settleDataRuns(bench, eligibleId, 1)).toHaveLength(1);

    // Not vacuous: both skipped documents really landed in the corpus — the
    // waker declined them, the ingest path did not drop them.
    const bulkRow = documentRow(bench, BULK);
    const staleRow = documentRow(bench, STALE);
    expect(bulkRow?.title).toBe(BULK.title);
    expect(staleRow?.title).toBe(STALE.title);

    expect(await dataRunsFor(bench, bulkRow!.id)).toHaveLength(0);
    expect(await dataRunsFor(bench, staleRow!.id)).toHaveLength(0);
    expect(bench.puppetCalls.filter((c) => c.subject === bulkRow!.id)).toHaveLength(0);
    expect(bench.puppetCalls.filter((c) => c.subject === staleRow!.id)).toHaveLength(0);
  }, 120_000);

  test("an addressed-to-agent document wakes immediately and its prompt says so", async () => {
    const [docId] = await bench.pushAndSettle([ADDRESSED]);
    const created = await settleDataRuns(bench, docId!, 1);
    expect(created).toHaveLength(1);

    const createdRunId = puppetRunIdsFor(bench, docId!, "data.created")[0]!;
    const prompt = await bench.obs.promptFor(createdRunId);
    expect(prompt).toContain("EXPLICITLY addressed to you");

    // Immediacy is only observable on an UPDATE — a fresh insert carries no
    // debounce either way. An addressed update must beat the per-document
    // update debounce every other document answers to.
    //
    // Measured on the queue row rather than on wall-clock elapsed: the waker's
    // decision IS the gap it wrote between `enqueued_at` and `next_attempt_at`,
    // and reading it directly says what the test means. Timing the round trip
    // instead would measure the machine's load as much as the waker's choice,
    // and go red on a busy box while the behaviour was perfectly correct.
    await bench.update(ADDRESSED, ADDRESSED_V2);
    const updated = await waitFor(
      `an addressed update run for ${docId!}`,
      async () => {
        const rows = await dataRunsFor(bench, docId!);
        const update = rows.find((r) => {
          const payload = bench.runPayload(r.id) as { event?: string } | null;
          return payload?.event === "updated";
        });
        return update ?? null;
      },
      60_000,
      100,
    );
    const row = bench.runRow(updated.id)!;
    const debounceMs = Number(row.next_attempt_at) - Number(row.enqueued_at);
    // The fast path is not "a bit quicker than the debounce" — it waives it,
    // so the gap the waker wrote is essentially zero. A bound just under
    // `UPDATE_DEBOUNCE_MS` would pass on a debounce that had merely been
    // shortened by a millisecond.
    expect(debounceMs).toBeLessThan(1_000);

    await bench.drainUntilQuiet();
    const updateRunIds = puppetRunIdsFor(bench, docId!, "data.updated");
    expect(updateRunIds).toHaveLength(1);
    expect(await bench.obs.promptFor(updateRunIds[0]!)).toContain("EXPLICITLY addressed to you");
  }, 120_000);

  test("deleting a document degrades its in-flight run instead of orphaning it", async () => {
    const [docId] = await bench.pushAndSettle([DOOMED]);
    expect(await settleDataRuns(bench, docId!, 1)).toHaveLength(1);

    // Edit it, then delete it while the debounced run is still pending: the
    // buffer eviction cannot help here — the run row already exists.
    await bench.update(DOOMED, DOOMED_V2);
    // Catch the row while it is scheduled but not claimed. Normally its quiet
    // window is UPDATE_DEBOUNCE_MS; under derivation load the readiness barrier
    // may schedule it farther out. Deletion must release either form without
    // confusing an actively executing row (also persisted as `pending`) for
    // one that is still waiting.
    let seenRows = "(none)";
    const pending = await waitFor(
      () => `a scheduled data run for ${docId!} before claim; saw ${seenRows}`,
      async () => {
        const rows = await dataRunsFor(bench, docId!);
        seenRows =
          rows
            .map(
              (r) =>
                `${r.status}(running=${r.running},attempts=${r.attempts},next=${r.nextAttemptAt ?? "-"})`,
            )
            .join(", ") || "(none)";
        const now = Date.now();
        return (
          rows.find(
            (r) =>
              r.status === "pending" &&
              !r.running &&
              r.nextAttemptAt !== null &&
              Date.parse(r.nextAttemptAt) > now,
          ) ?? null
        );
      },
      Math.max(60_000, UPDATE_DEBOUNCE_MS * 4),
      100,
    );

    await bench.deleteDoc(docId!);
    expect(documentRow(bench, DOOMED)).toBeUndefined();

    const runs = await settleDataRuns(bench, docId!, 2);
    expect(runs).toHaveLength(2);
    const degraded = runs.find((r) => r.id === pending.id);
    expect(degraded).toBeDefined();
    expect(degraded!.status).toBe("completed");

    // The run was told its subject is gone, and the puppet no-opped it.
    expect(await bench.obs.promptFor(degraded!.id)).toContain(
      `${docId!} that triggered this run has been DELETED`,
    );
    expect(await bench.obs.diffFor(degraded!.id)).toBeNull();
    expect(puppetRunIdsFor(bench, docId!, "data.deleted")).toEqual([degraded!.id]);

    // No orphan left behind, and the engine is healthy.
    expect((await dataRunsFor(bench, docId!)).filter((r) => r.status === "pending")).toHaveLength(
      0,
    );
    const pulse = await bench.obs.pulse();
    expect(pulse.counts.queuedRuns).toBe(0);
    expect(pulse.runningRuns).toHaveLength(0);
    expect(pulse.counts.failedRuns24h).toBe(0);
  }, 240_000);
});
