// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain bench — the waker's volume gates and its readiness barrier.
 *
 * `brain-waker.e2e.test.ts` pins the shape of a wake: arrival, diff-carrying
 * update, the per-document fold, the addressed-to-agent fast path. This file
 * pins the two questions that decide whether a wake happens at all, and when.
 *
 * What must not wake: the three metadata volume markers a real corpus arrives
 * in bulk — machine notifications (`automatedSender`), continuously rewritten
 * day rollups (`rollingAggregate`, which is also the only thing standing
 * between an off-host agent transcript and the engine reasoning over its own
 * delivered output, since the projecting source is not registered as
 * cognition-authored), and caption-less items (`lowSignal`) — plus the
 * metadata churn every mail, notes and task source emits on each poll.
 * Against each, a plain document pushed in the same batch that does wake, so a
 * suite that had stopped waking at all could not read as a pass.
 *
 * What must still wake: a dated obligation from a transactional sender. The
 * promoted-date override is an exception carved into an exception — it lifts
 * the bulk-mail and automated-sender gates and nothing else — so it is pinned
 * from both sides: the confirmation wakes, and the same document backdated or
 * marked as a rolling aggregate does not.
 *
 * How a thread folds: three messages of one mail thread are three documents,
 * three buffer entries and one queue row, keyed on the source-scoped thread
 * identity. Ten messages must buy one run, not ten. Each fold is driven and
 * observed on its own, because a burst pushed all at once can drain in a
 * single tick and hide which message the surviving row describes.
 *
 * When a run becomes claimable: the readiness barrier. Derivation is stalled
 * deliberately — the link drip is parked on an hour-long cadence for the whole
 * bench and only ingest nudges it, five documents a tick, so a wall of
 * undeduced rows written straight to the table keeps the subject's
 * `links_extracted_at` NULL for as long as the test needs — and the barrier's
 * hold, its release the instant the subject's own columns are stamped, and the
 * `immediate` opt-out are read off the queue row rather than timed off the
 * wall clock. Every other bench pins the barrier to seconds, so a barrier that
 * never released would pass them all; this one gives it an hour and proves it
 * gives the time back.
 *
 * An end-to-end rather than unit tests because both halves are contracts
 * between parts that never meet in a unit: the waker decides from a projection
 * the ingest route builds, and the barrier's release depends on columns owned
 * by the scheduler's drips, read back through the queue the drainer claims
 * from. `eligibility.test.ts` and `drain-task.test.ts` prove the arithmetic;
 * only a real gateway proves the markers survive ingest and that the release
 * pass and the derivation columns agree.
 *
 * Every test pins all four waker knobs it depends on at its top, so the file
 * is order-independent and a test appended after these ones inherits nothing.
 *
 * Everything here is invented: fictional people on reserved example domains
 * and fictional vendors.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  CAST,
  addressedToAgent,
  compressCognitionCadences,
  email,
  note,
  waitFor,
  type BenchDoc,
  type RunDto,
} from "./brain-bench/index.js";

compressCognitionCadences();

/**
 * The conversation debounce test 3 folds a thread inside. Long enough that
 * three staged pushes and their observations fit with seconds to spare on a
 * shared box, short enough to stay inside `drainUntilQuiet`'s upcoming-run
 * horizon so the debounced run is waited out rather than raced past.
 */
const THREAD_DEBOUNCE = "12s";

/** The readiness barrier test 5 runs with — long enough that it cannot expire into a pass. */
const LONG_BARRIER_MS = 3_600_000;

/**
 * Undeduced rows written ahead of the barrier test's subject. The link drip
 * takes five documents a tick and, parked on an hour cadence, only ticks when
 * an ingest nudges it — and the test ingests twice after the wall is up. Sixty
 * is a twelvefold margin on that count.
 */
const WALL_ROWS = 60;

// ── fold keys, spelled literally ────────────────────────────────────────────

const docKey = (docId: string): string => `data:doc:${docId}`;
/**
 * Thread ids are unique only within a source, so the fold key bakes the source
 * in. Spelled out here rather than imported so a regression that drops the
 * scoping — and merges two unrelated conversations onto one run — reddens.
 */
const threadKey = (sourceId: string, threadId: string): string =>
  `data:thread:${sourceId}:${threadId}`;

// ── probes ──────────────────────────────────────────────────────────────────

interface DocRow {
  id: string;
  title: string;
  metadata: string;
  provider_id: string;
  source_id: string;
  content_hash: string;
  links_extracted_at: string | null;
  people_resolved_at: string | null;
  dates_extracted_at: string | null;
}

/** A document as the corpus holds it — the non-vacuity check behind every skip. */
function documentRow(bench: BrainBench, externalId: string): DocRow | undefined {
  return bench.sql
    .prepare<
      [string],
      DocRow
    >(`SELECT id, title, metadata, provider_id, source_id, content_hash, links_extracted_at, people_resolved_at, dates_extracted_at FROM documents WHERE external_id = ?`)
    .get(externalId);
}

/**
 * Every `data` run — settled or not — folded on one queue identity.
 *
 * Keyed on the dedupe key rather than a document id, because a thread's run is
 * keyed on the thread and belongs to no single message. Empty list, never a
 * throw, for a document the waker declined.
 */
async function runsForKey(bench: BrainBench, dedupeKey: string): Promise<RunDto[]> {
  const page = await bench.obs.runs({ kind: "data" });
  return page.items.filter((r) => r.dedupeKey === dedupeKey);
}

/**
 * Wait for a queue identity's `data` runs to settle.
 *
 * `drainUntilQuiet` alone is not enough: the pulse counts a run as queued only
 * once its turn has arrived, so a run inside its debounce or behind the
 * readiness barrier reads as a quiet engine. Wait for the rows to settle
 * first, then drain, then re-read.
 */
async function settleRunsForKey(
  bench: BrainBench,
  dedupeKey: string,
  count: number,
  opts: { timeoutMs?: number; stallMs?: number } = {},
): Promise<RunDto[]> {
  let seen = "(none)";
  await waitFor(
    () => `${count} settled data run(s) on ${dedupeKey}; last seen ${seen}`,
    async () => {
      const rows = await runsForKey(bench, dedupeKey);
      seen = rows.map((r) => `${r.status}(next=${r.nextAttemptAt ?? "-"})`).join(", ") || "(none)";
      const settled = rows.filter((r) => r.status !== "pending");
      return settled.length >= count ? settled : null;
    },
    opts.timeoutMs ?? 90_000,
    200,
  );
  await bench.drainUntilQuiet(opts.stallMs === undefined ? {} : { stallMs: opts.stallMs });
  return (await runsForKey(bench, dedupeKey)).filter((r) => r.status !== "pending");
}

/** Queue rows ever minted on one fold key — the spend contract, in one number. */
function runRowsOnKey(bench: BrainBench, dedupeKey: string): number {
  return (
    bench.sql
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM cognition_runs WHERE dedupe_key = ?")
      .get(dedupeKey)?.n ?? 0
  );
}

/** The still-pending run on a fold key, if the waker has minted one. */
function pendingRunId(bench: BrainBench, dedupeKey: string): string | null {
  return (
    bench.sql
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM cognition_runs WHERE dedupe_key = ? AND status = 'pending'")
      .get(dedupeKey)?.id ?? null
  );
}

/**
 * Distinct run ids the puppet was asked to act on for one subject.
 *
 * Distinct ids, not call counts: with an empty behavior table every
 * document-subject run serves two completions — an automatic `fetch_many`,
 * then the no-op final turn — so counting calls would say two where the
 * machine did one thing.
 */
function puppetRunIdsFor(bench: BrainBench, subject: string, flavour: string): string[] {
  const ids = new Set<string>();
  for (const c of bench.puppetCalls) {
    if (c.subject === subject && c.flavour === flavour && c.runId) ids.add(c.runId);
  }
  return [...ids];
}

/** Every completion the puppet served about one subject, whatever the flavour. */
function puppetCallsAbout(bench: BrainBench, subject: string): number {
  return bench.puppetCalls.filter((c) => c.subject === subject).length;
}

/** The barrier payload a held `data` run advertises. */
interface BarrierPayload {
  docId?: unknown;
  debounceUntil?: unknown;
  barrierUntil?: unknown;
}

const barrierPayload = (bench: BrainBench, runId: string): BarrierPayload =>
  (bench.runPayload(runId) ?? {}) as BarrierPayload;

/**
 * Pin every waker knob a test reads, so no test inherits a predecessor's
 * config. `recencyWindow` is pinned at its shipped default because two arms
 * depend on a document being outside it.
 */
async function pinWakerKnobs(
  bench: BrainBench,
  opts: {
    conversationDebounce?: string;
    documentUpdateDebounce?: string;
    derivationBarrier?: string;
  } = {},
): Promise<void> {
  await bench.patchConfig({
    brain: {
      conversationDebounce: opts.conversationDebounce ?? "2s",
      documentUpdateDebounce: opts.documentUpdateDebounce ?? "2s",
      derivationBarrier: opts.derivationBarrier ?? "2s",
      recencyWindow: "7d",
    },
  });
}

// ── stimuli ─────────────────────────────────────────────────────────────────

const AUTOMATED = email({
  externalId: "gate-automated",
  title: "Your order has shipped",
  content:
    "Your order is on its way. Track it from the link below.\nThis mailbox is not monitored.",
  metadata: { automatedSender: true, from: "noreply@example.com" },
});

const ROLLUP = note({
  externalId: "gate-rollup",
  title: "Activity rollup for thursday",
  content: "Steps: 8,140. Sleep: 7h 05m. Two workouts logged.",
  metadata: { rollingAggregate: true },
});

/**
 * A photo with nothing extractable in it. The gate reads `metadata.lowSignal`,
 * not the empty body — do not "fix" this fixture by giving it text.
 */
const LOW_SIGNAL = note({
  externalId: "gate-photo",
  title: "Photo with no caption",
  content: "",
  metadata: { lowSignal: true },
});

/**
 * An off-host agent transcript in its real shape (`renderConversationDay` in
 * `@omnesis/core`): a `conversation` carrying `rollingAggregate`, a tag pair
 * and an `extra` block keyed on the chat, never a thread id. The projecting
 * source is NOT registered as cognition-authored — `conversation` is shared
 * with every messaging source, so registering the type would drop the
 * operator's real threads — which makes the rolling-aggregate marker the only
 * thing between the engine and a deliver-transcribe-wake loop over its own
 * output.
 */
const TRANSCRIPT_ROLLUP: BenchDoc = {
  externalId: "gate-transcript",
  title: "Assistant transcript for the rehearsal week",
  content:
    "09:12 you: what is left before the showcase?\n09:12 assistant: the van hire quote and the rider.",
  documentType: "conversation",
  metadata: {
    rollingAggregate: true,
    tags: ["openclaw", "local"],
    extra: {
      harness: "openclaw",
      agent: "openclaw",
      channel: "local",
      chatId: null,
      messageCount: 2,
    },
  },
};

/** Control A — a `conversation` with no marker. The document type is not the gate. */
const CONTROL_CONVERSATION: BenchDoc = {
  externalId: "gate-conversation-plain",
  title: `Rehearsal thread with ${CAST.maya.name}`,
  content: `${CAST.maya.name}: can we hold the thursday slot?\nyou: yes, booking it now.`,
  documentType: "conversation",
};

/** Control B — an ordinary mail, pushed last so its row dates the whole batch. */
const CONTROL_MAIL = email({
  externalId: "gate-control",
  title: "Van hire quote for the autumn showcase",
  content:
    "The van hire quote for the autumn showcase is attached.\nTell us if you want the larger vehicle.",
});

const DUE_BODY =
  "Your booking is confirmed. The balance is due before arrival.\nThis mailbox is not monitored.";

/** The transactional confirmation the promoted-date override exists for. */
function datedConfirmation(externalId: string, marker: Record<string, unknown>): BenchDoc {
  return {
    externalId,
    title: "Booking confirmation for the autumn showcase",
    content: DUE_BODY,
    documentType: "email",
    metadata: {
      bulkMail: true,
      automatedSender: true,
      from: "noreply@example.org",
      ...marker,
    },
  };
}

const THREAD_ID = "thr-autumn";
const OTHER_THREAD_ID = "thr-vanhire";

function threadMessage(externalId: string, threadId: string, body: string): BenchDoc {
  return email({
    externalId,
    title: "Load-in schedule for the autumn showcase",
    content: body,
    metadata: { extra: { threadId } },
  });
}

const CHURN_BODY =
  "Please send the deposit before the end of the week so the room stays held.\nInvoice attached.";
const CHURN_BODY_V2 =
  "Please send the deposit before the end of the month so the room stays held.\nInvoice attached.";

describe("Brain waker — volume gates and the readiness barrier", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      brain: {
        conversationDebounce: "2s",
        documentUpdateDebounce: "2s",
        derivationBarrier: "2s",
        // Not part of the bench's quiet baseline, and it enqueues onto the
        // same queue these tests count rows in.
        mergeAdjudication: { enabled: false },
      },
      extraGatewayConfig: {
        // Date extraction off for the whole file: the stage is gated on
        // experimental AND this flag, so switching it off drops `dates` from
        // the barrier's active set and leaves it waiting on links and people
        // — the two stages this file can drive. A switched-off stage never
        // stamps its column, so had it stayed active the barrier could never
        // release and the last test would time out instead of passing.
        enrichment: { dates: { enabled: false } },
        // The link drip, parked. Its cadence is captured when the task is
        // constructed, so this has to be boot config rather than a live patch.
        // Ingest still nudges it once per upsert, which is bounded and takes
        // five documents a tick — enough for the barrier test to keep a
        // document undeduced for as long as it needs, and harmless everywhere
        // else, where the barrier is two seconds and simply elapses.
        gateway: { backfill: { links: { interval: "1h", idleDelay: "1h" } } },
      },
      // Every run a no-op: this file asserts on the queue, not on writes.
      behaviors: { behaviors: [] },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the three volume markers never wake the agent, and a plain document in the same batch does", async () => {
    await pinWakerKnobs(bench);

    // The ambient corpus is dated outside the recency window, so anything the
    // rest of this test attributes to its own stimulus starts from zero.
    expect((await bench.obs.runs({ kind: "data" })).items).toHaveLength(0);

    await bench.pushAll([
      AUTOMATED,
      ROLLUP,
      LOW_SIGNAL,
      TRANSCRIPT_ROLLUP,
      CONTROL_CONVERSATION,
      CONTROL_MAIL,
    ]);

    // The two controls are the horizon for the four negatives. Every document
    // in the batch passed through the same emit and the same buffer, and the
    // controls were pushed last — so a drain tick that produced a control's
    // row has already drained every wake buffered before it. A sibling row the
    // waker had wrongly decided to enqueue would exist by now.
    const controlMailId = await bench.docId(CONTROL_MAIL.externalId);
    const controlConversationId = await bench.docId(CONTROL_CONVERSATION.externalId);
    const mailRuns = await settleRunsForKey(bench, docKey(controlMailId), 1);
    const conversationRuns = await settleRunsForKey(bench, docKey(controlConversationId), 1);

    expect(mailRuns).toHaveLength(1);
    expect(mailRuns[0]!.status).toBe("completed");
    // Control A is the discriminator that keeps the gate honest about WHAT it
    // reads: a regression that started skipping every `conversation` document
    // would go quiet here rather than read as correctly quiet.
    expect(conversationRuns).toHaveLength(1);
    expect(conversationRuns[0]!.status).toBe("completed");

    for (const doc of [AUTOMATED, ROLLUP, LOW_SIGNAL, TRANSCRIPT_ROLLUP]) {
      const id = await bench.docId(doc.externalId);
      // Not vacuous: the document really landed. The waker declined it; the
      // ingest path did not drop it.
      expect(documentRow(bench, doc.externalId)?.title).toBe(doc.title);
      expect(await runsForKey(bench, docKey(id))).toHaveLength(0);
      expect(puppetCallsAbout(bench, id)).toBe(0);
    }
  }, 180_000);

  test("a dated obligation from a transactional sender wakes; the override lifts only the bulk and automated gates", async () => {
    await pinWakerKnobs(bench);

    const dueAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const scheduledAt = new Date(Date.now() + 6 * 86_400_000).toISOString();
    // Four copies of one document differing in exactly one field each, so the
    // pass states the override's boundary rather than one side of it.
    const live = datedConfirmation("due-live", { dueAt });
    const stale: BenchDoc = { ...datedConfirmation("due-stale", { dueAt }), ageDays: 60 };
    const rollup = datedConfirmation("due-rollup", { dueAt, rollingAggregate: true });
    const scheduled = datedConfirmation("sched-live", { scheduledAt });
    const control = email({
      externalId: "due-control",
      title: "Rider notes for the autumn showcase",
      content: "Here are the rider notes for the autumn showcase. Send back any changes.",
    });

    await bench.pushAll([live, stale, rollup, scheduled, control]);
    const controlId = await bench.docId(control.externalId);
    expect(await settleRunsForKey(bench, docKey(controlId), 1)).toHaveLength(1);

    for (const doc of [live, scheduled]) {
      const id = await bench.docId(doc.externalId);
      const runs = await settleRunsForKey(bench, docKey(id), 1);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("completed");
      expect(puppetRunIdsFor(bench, id, "data.created")).toEqual([runs[0]!.id]);
    }

    for (const doc of [stale, rollup]) {
      const id = await bench.docId(doc.externalId);
      expect(documentRow(bench, doc.externalId)?.title).toBe(doc.title);
      expect(await runsForKey(bench, docKey(id))).toHaveLength(0);
      expect(puppetCallsAbout(bench, id)).toBe(0);
    }
  }, 180_000);

  test("a burst of same-thread messages folds onto one thread-keyed run carrying the latest message", async () => {
    // The barrier is deliberately shorter than the debounce here, so the row's
    // schedule is the debounce alone and nothing this test reads is a barrier
    // deadline in disguise.
    await pinWakerKnobs(bench, { conversationDebounce: THREAD_DEBOUNCE });

    const m1 = threadMessage("thread-m1", THREAD_ID, "Load-in starts at seven. Bring the stands.");
    const m2 = threadMessage(
      "thread-m2",
      THREAD_ID,
      "Make that half past seven — the van is late.",
    );
    const m3 = threadMessage("thread-m3", THREAD_ID, "Half past seven confirmed. Ramp is booked.");
    const other = threadMessage(
      "thread-other",
      OTHER_THREAD_ID,
      "The larger vehicle is available.",
    );

    // Each message is pushed and its fold observed on its own. Pushed as one
    // burst, two of them can drain in a single tick and the surviving row
    // would already describe the later message before the first read.
    await bench.push(m1);
    const m1Id = await bench.docId(m1.externalId);
    const sourceId = documentRow(bench, m1.externalId)!.source_id;
    const key = threadKey(sourceId, THREAD_ID);

    const threadRunId = await waitFor(
      () => `the thread-keyed pending run on ${key}; pending keys: ${bench.pendingDedupeKeys()}`,
      () => pendingRunId(bench, key),
      30_000,
      100,
    );
    expect(runRowsOnKey(bench, key)).toBe(1);
    expect(barrierPayload(bench, threadRunId).docId).toBe(m1Id);

    await bench.push(m2);
    const m2Id = await bench.docId(m2.externalId);
    await waitFor(
      () =>
        `the thread run to fold onto ${m2Id} (currently ${String(barrierPayload(bench, threadRunId).docId)})`,
      () => (barrierPayload(bench, threadRunId).docId === m2Id ? m2Id : null),
      30_000,
      100,
    );
    // The load-bearing assertion: the second message bought no second row.
    expect(runRowsOnKey(bench, key)).toBe(1);

    await bench.push(m3);
    const m3Id = await bench.docId(m3.externalId);
    await waitFor(
      () =>
        `the thread run to fold onto ${m3Id} (currently ${String(barrierPayload(bench, threadRunId).docId)})`,
      () => (barrierPayload(bench, threadRunId).docId === m3Id ? m3Id : null),
      30_000,
      100,
    );
    expect(runRowsOnKey(bench, key)).toBe(1);

    // No per-message key was ever minted — three documents, one queue identity.
    const pending = bench.pendingDedupeKeys();
    for (const id of [m1Id, m2Id, m3Id]) expect(pending).not.toContain(docKey(id));

    // A second thread, pushed after the first fold is pinned, gets its own row:
    // the scoping is per thread, not per source.
    await bench.push(other);
    const otherKey = threadKey(sourceId, OTHER_THREAD_ID);
    await waitFor(
      () => `the second thread's pending run on ${otherKey}`,
      () => pendingRunId(bench, otherKey),
      30_000,
      100,
    );
    expect(runRowsOnKey(bench, otherKey)).toBe(1);

    // Both threads sit out their own debounce; give the drain room for it.
    await bench.drainUntilQuiet({ stallMs: 45_000, timeoutMs: 150_000 });

    const threadRuns = (await runsForKey(bench, key)).filter((r) => r.status !== "pending");
    const otherRuns = (await runsForKey(bench, otherKey)).filter((r) => r.status !== "pending");
    expect(threadRuns).toHaveLength(1);
    expect(otherRuns).toHaveLength(1);
    expect(threadRuns[0]!.status).toBe("completed");
    expect(otherRuns[0]!.status).toBe("completed");

    // The run reasons about the thread as of its latest message, and about it
    // only once.
    expect(puppetRunIdsFor(bench, m3Id, "data.created")).toEqual([threadRuns[0]!.id]);
    expect(puppetCallsAbout(bench, m1Id)).toBe(0);
    expect(puppetCallsAbout(bench, m2Id)).toBe(0);
  }, 240_000);

  test("a re-sync with identical content and changed metadata never wakes, while a real edit to the same document does", async () => {
    await pinWakerKnobs(bench);

    // One absolute instant across all three pushes, so the source timestamps
    // are byte-identical and metadata is the only thing that moves.
    const at = Date.now();
    const churn = email({
      externalId: "churn-doc",
      title: "Deposit request for the autumn showcase",
      content: CHURN_BODY,
      at,
    });

    await bench.push(churn);
    const churnId = await bench.docId(churn.externalId);
    expect(await settleRunsForKey(bench, docKey(churnId), 1)).toHaveLength(1);
    const hashAfterCreate = documentRow(bench, churn.externalId)!.content_hash;

    // The production shape: a label added, a note re-tagged, a read flag
    // flipped — same body, new metadata. The upsert replaces metadata
    // wholesale and nulls the derivation columns whenever it does, which is
    // why the barrier is pinned low here and must not be raised.
    await bench.push({ ...churn, metadata: { tags: ["invoices"] } });
    const churned = await waitFor(
      () => `the metadata-only upsert to land on ${churn.externalId}`,
      () => {
        const row = documentRow(bench, churn.externalId);
        if (!row) return null;
        const meta = JSON.parse(row.metadata) as { tags?: unknown };
        return Array.isArray(meta.tags) && meta.tags[0] === "invoices" ? row : null;
      },
      30_000,
      100,
    );
    // Not vacuous, and the two halves say different things: the tag proves the
    // write landed and the projection changed — so the event fired and was not
    // suppressed as a no-op — while the unchanged hash proves the body did
    // not, which is the sole reason the waker is entitled to decline it.
    expect(churned.content_hash).toBe(hashAfterCreate);

    // A sentinel, not a sleep. Document events reach the waker's buffer
    // synchronously on ingest and one drain empties the whole buffer, so once
    // the sentinel's own row exists, any row the churn upsert had bought
    // exists too.
    const sentinel = email({
      externalId: "churn-sentinel",
      title: "Stage plan for the autumn showcase",
      content: "The stage plan for the autumn showcase is attached. Confirm the risers.",
    });
    await bench.push(sentinel);
    const sentinelId = await bench.docId(sentinel.externalId);
    await waitFor(
      () => `the sentinel's own data run on ${docKey(sentinelId)}`,
      async () => ((await runsForKey(bench, docKey(sentinelId))).length > 0 ? true : null),
      60_000,
      100,
    );
    expect(await runsForKey(bench, docKey(churnId))).toHaveLength(1);
    expect(bench.pendingDedupeKeys()).not.toContain(docKey(churnId));

    // Step three is a pure content change on the same document — the
    // discriminator that proves the waker is still alive for THIS document, on
    // THIS key, at THIS moment.
    await bench.push({ ...churn, metadata: { tags: ["invoices"] }, content: CHURN_BODY_V2 });
    const runs = await settleRunsForKey(bench, docKey(churnId), 2);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
    expect(puppetRunIdsFor(bench, churnId, "data.updated")).toHaveLength(1);
    expect(await runsForKey(bench, docKey(churnId))).toHaveLength(2);
  }, 240_000);

  test("the readiness barrier defers a run until its datum is derived, gives the time back the moment it is, and never delays a document addressed to the agent", async () => {
    await pinWakerKnobs(bench, { derivationBarrier: "1h" });

    // An anchor whose only job is to name the push source's ids for the wall
    // below. Bulk mail, so it wakes nothing and leaves the queue alone.
    const anchor = email({
      externalId: "barrier-anchor",
      title: "Seasonal offers from the rehearsal rooms",
      content: "This month's offers. Unsubscribe with the link below.",
      metadata: { bulkMail: true },
    });
    await bench.push(anchor);
    await bench.docId(anchor.externalId);
    const anchorRow = documentRow(bench, anchor.externalId)!;

    // The wall. Written straight to the table, so it emits no events and wakes
    // nothing itself. Three independent orderings put it ahead of the subject
    // in the drip's batch, so the stall does not rest on a query plan: the ids
    // sort below any minted identifier, the ingest stamps are backdated, and
    // the rows are inserted before the subject exists.
    const stamp2020 = "2020-01-01T00:00:00.000Z";
    const inserted = bench.withWriteHandle((db) => {
      const insert = db.prepare(
        `INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content,
                                content_hash, metadata, source_created_at, source_updated_at,
                                ingested_at, updated_at)
         VALUES (?, ?, ?, ?, '', ?, ?, ?, '{}', ?, ?, ?, ?)`,
      );
      return db.transaction(() => {
        let n = 0;
        for (let i = 0; i < WALL_ROWS; i += 1) {
          const seq = String(i).padStart(4, "0");
          n += insert.run(
            `!barrier-filler-${seq}`,
            anchorRow.provider_id,
            anchorRow.source_id,
            `barrier-filler-${seq}`,
            `Filler note ${seq}`,
            `Filler body ${seq}. Nothing here refers to anything.`,
            `sha256:barrier-filler-${seq}`,
            stamp2020,
            stamp2020,
            stamp2020,
            stamp2020,
          ).changes;
        }
        return n;
      })();
    });
    expect(inserted).toBe(WALL_ROWS);

    // ── HOLD ────────────────────────────────────────────────────────────────
    const subject = email({
      externalId: "barrier-subject",
      title: "Catering order for the autumn showcase",
      content: "Here is the catering order for the autumn showcase. Headcount is forty guests.",
    });
    await bench.push(subject);
    const subjectId = await bench.docId(subject.externalId);
    const held = await waitFor(
      () => `a pending data run on ${docKey(subjectId)}`,
      () => {
        const runId = pendingRunId(bench, docKey(subjectId));
        if (runId === null) return null;
        return {
          runId,
          nextAttemptAt: Number(bench.runRow(runId)!["next_attempt_at"]),
          payload: barrierPayload(bench, runId),
          links: documentRow(bench, subject.externalId)!.links_extracted_at,
        };
      },
      60_000,
      100,
    );

    // The honest reason it is held, read at the moment it was held.
    expect(held.links).toBeNull();
    expect(held.payload.docId).toBe(subjectId);
    expect(typeof held.payload.debounceUntil).toBe("number");
    expect(typeof held.payload.barrierUntil).toBe("number");
    const debounceUntil = held.payload.debounceUntil as number;
    const barrierUntil = held.payload.barrierUntil as number;
    // Both deadlines are computed from one instant inside a single drain
    // iteration, so this is exact arithmetic and not a tolerance. A fresh
    // insert carries no debounce, so the whole hour is the barrier's.
    expect(barrierUntil - debounceUntil).toBe(LONG_BARRIER_MS);
    // The row advertises the barrier's claim — which is what the release pass
    // matches on, and what stops it cancelling a wait it did not impose.
    expect(held.nextAttemptAt).toBe(barrierUntil);

    // ── OPT-OUT ─────────────────────────────────────────────────────────────
    // Pushed while the wall is still up, so it faces exactly the same
    // underived state. This arm is the reason the barrier can be given an hour
    // at all: content the user handed to the assistant must not queue behind
    // background derivation.
    const addressed = addressedToAgent({
      externalId: "barrier-addressed",
      title: "Note to the assistant about the autumn showcase",
      content: `Remember that ${CAST.maya.name} is running front of house for the autumn showcase.`,
    });
    await bench.push(addressed);
    const addressedId = await bench.docId(addressed.externalId);
    const addressedRun = await waitFor(
      () => `a data run on ${docKey(addressedId)}`,
      async () => {
        const rows = await runsForKey(bench, docKey(addressedId));
        const row = rows[0];
        if (!row) return null;
        return {
          id: row.id,
          payload: barrierPayload(bench, row.id),
          links: documentRow(bench, addressed.externalId)!.links_extracted_at,
        };
      },
      60_000,
      100,
    );
    expect(addressedRun.links).toBeNull();
    expect(addressedRun.payload.barrierUntil).toBeUndefined();
    const addressedSettled = await settleRunsForKey(bench, docKey(addressedId), 1);
    expect(addressedSettled).toHaveLength(1);
    expect(addressedSettled[0]!.status).toBe("completed");

    // The addressed document has been through a whole run while the subject is
    // still parked exactly where the barrier put it.
    expect(Number(bench.runRow(held.runId)!["next_attempt_at"])).toBe(barrierUntil);
    expect(documentRow(bench, subject.externalId)!.links_extracted_at).toBeNull();

    // ── RELEASE ─────────────────────────────────────────────────────────────
    // Stamp the subject's own columns: one row, no dependence on any drip's
    // cadence, and the wall stays up so nothing else moves.
    const readyAt = new Date().toISOString();
    const stamped = bench.withWriteHandle(
      (db) =>
        db
          .prepare(
            "UPDATE documents SET links_extracted_at = ?, people_resolved_at = ? WHERE id = ?",
          )
          .run(readyAt, readyAt, subjectId).changes,
    );
    expect(stamped).toBe(1);

    const released = await waitFor(
      () => `the readiness barrier to release ${held.runId} from ${barrierUntil}`,
      () => {
        const row = bench.runRow(held.runId)!;
        const next = Number(row["next_attempt_at"]);
        if (next === barrierUntil) return null;
        return {
          next,
          attempts: Number(row["attempts"]),
          lastError: row["last_error"],
          failureCode: row["failure_code"],
        };
      },
      120_000,
      50,
    );
    // The release target is `max(now, debounceUntil)` with the debounce long
    // since elapsed, so the run is due at once — an hour early. A soft-failure
    // backoff would land in the future and leave an error and a spent attempt
    // behind, so it cannot masquerade as a release here.
    expect(released.next).toBeLessThanOrEqual(Date.now());
    expect(released.lastError).toBeNull();
    expect(released.failureCode).toBeNull();
    expect(released.attempts).toBeLessThanOrEqual(1);
    // The release moves the schedule and never rewrites the payload — which is
    // what lets the compare-and-set tell its own hold from a retry or a fold.
    expect(barrierPayload(bench, held.runId).barrierUntil).toBe(barrierUntil);

    // Date extraction is off for this bench, so `dates_extracted_at` is NULL
    // for every row in the database and always was. On its own that says
    // nothing; taken with the release above it is the whole statement — a run
    // whose subject has a NULL date column released anyway, which it could not
    // have done if a switched-off stage were still in the barrier's active set.
    expect(documentRow(bench, subject.externalId)!.dates_extracted_at).toBeNull();

    await bench.drainUntilQuiet();
    const settled = (await runsForKey(bench, docKey(subjectId))).filter(
      (r) => r.status !== "pending",
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.id).toBe(held.runId);
    expect(settled[0]!.status).toBe("completed");
    expect(puppetRunIdsFor(bench, subjectId, "data.created")).toEqual([held.runId]);
  }, 300_000);
});
