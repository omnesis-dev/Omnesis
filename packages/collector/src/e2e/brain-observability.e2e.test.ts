// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — area J: the operator-facing surface, and the golden snapshot.
 *
 * Everything an operator can see about the Cognition Steward is a projection
 * over rows the engine wrote: the pulse summarises the queue and the stores,
 * the decision view folds a transcript down to "what did it decide", spend and
 * attribution say what each run cost and which workflow produced it, coverage
 * says how much of a source has been reasoned over, and the `omnesis brain`
 * CLI renders all of it. A projection that quietly stops agreeing with its
 * source is invisible from inside the projection — so every assertion here
 * reconciles the surface against the rows it summarises, never against a
 * hand-written expectation of the surface alone.
 *
 * Two gateways. The first runs a scripted day of mixed activity (three datum
 * runs, a snooze, a scheduled follow-up, a dismissal) and is read through
 * every operator surface in turn, ending with a retention sweep that must take
 * the transcripts and leave the run rows. The second is deliberately bare —
 * no ambient corpus, one document, one run — because a whole-state snapshot
 * is only comparable when the ids it canonicalises are minted in a
 * reproducible order.
 */

import "./synth-env.js";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  ref,
  sleep,
  snapshotBrainState,
  waitFor,
} from "./brain-bench/index.js";

compressCognitionCadences();

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, "../../../..");
const CLI_ENTRY = "packages/cli/src/index.ts";
const CLI_TIMEOUT_MS = 60_000;

// ── fixtures (invented from scratch: fictional vendors, amounts, references) ─

const INVOICE_MARKER = "obs-invoice";
const ROOM_MARKER = "obs-room";

const INVOICE_DOC = email({
  externalId: "brain-obs-invoice",
  title: "Cedar Grove Supplies invoice CG-8821",
  content: [
    "Hi Alex,",
    "",
    "Invoice CG-8821 for the workshop benches is now open on the account.",
    "The balance of four hundred and eighty is payable by the end of the month.",
    "Please confirm once the transfer has been made.",
    "",
    "Cedar Grove Supplies",
  ].join("\n"),
});
const INVOICE_QUOTE = "The balance of four hundred and eighty is payable by the end of the month.";
const INVOICE_CLAIM = "The invoice balance is payable by the end of the month.";

const ROOM_DOC = email({
  externalId: "brain-obs-room",
  title: "Studio Northstar rehearsal room hold",
  content: [
    "Hi Alex,",
    "",
    "The rehearsal room is held for the winter showcase until Friday.",
    "Tell us by then whether you also want the evening slot.",
    "",
    "Studio Northstar",
  ].join("\n"),
});

/** A datum the scripted steward deliberately does nothing about. */
const QUIET_DOC = email({
  externalId: "brain-obs-quiet",
  title: "Cedar Grove Supplies depot hours this week",
  content: [
    "Hi Alex,",
    "",
    "The depot keeps its usual hours for the whole of this week.",
    "",
    "Cedar Grove Supplies",
  ].join("\n"),
});

/** Far enough out that the drain never claims it — it must sit as upcoming. */
const FOLLOW_UP_AT = new Date(Date.now() + 3 * 86_400_000).toISOString();

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(bench: BrainBench, args: string[]): Promise<CliResult> {
  const cliEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OMNESIS_GATEWAY_URL: bench.harness.gatewayUrl,
    OMNESIS_TOKEN: bench.harness.apiKey,
    // Keep the CLI's TOFU trust state inside this harness: falling back to the
    // operator's own config would feed the child an unrelated certificate.
    OMNESIS_CONFIG_DIR: bench.harness.getConfigDir(),
    NO_COLOR: "1",
    CI: "1",
  };
  // The CLI must prove the harness certificate is sufficient on its own, so it
  // never inherits a parent-process TLS bypass.
  delete cliEnv.NODE_TLS_REJECT_UNAUTHORIZED;
  delete cliEnv.NODE_EXTRA_CA_CERTS;
  delete cliEnv.OMNESIS_INSECURE_TLS;
  try {
    const { stdout, stderr } = await execFileAsync("npx", ["tsx", CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: cliEnv,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
      exitCode: typeof e.code === "number" ? e.code : Number(e.code ?? -1),
    };
  }
}

describe("Brain Bench — the operator surface", () => {
  let bench: BrainBench;
  let invoiceDocId = "";
  let roomDocId = "";
  let quietDocId = "";

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: INVOICE_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: "Cedar Grove invoice" }),
                call("open_loop_create", {
                  title: `Pay the Cedar Grove invoice (${INVOICE_MARKER})`,
                  description: "Tracked from the invoice mail.",
                  confidence: 0.9,
                  importance: 0.8,
                  docs: [ctx.subject],
                }),
                call("open_loop_ledger_append", {
                  id: ref("open_loop_create", "loop.id"),
                  note: "Balance of four hundred and eighty due by the end of the month.",
                }),
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "payment-due",
                  claimText: INVOICE_CLAIM,
                  evidenceDocId: ctx.subject,
                  evidenceQuote: INVOICE_QUOTE,
                  confidence: 0.9,
                  claimBasis: "quoted",
                }),
                call("brief_create", {
                  kind: "loop",
                  title: `Invoice CG-8821 is due (${INVOICE_MARKER})`,
                  description: "The balance is payable at the end of the month.",
                  citations: [ctx.subject],
                  relatedLoopIds: [ref("open_loop_create", "loop.id")],
                  confidence: 0.9,
                  urgency: 0.6,
                  assertedClaims: [
                    {
                      claimText: INVOICE_CLAIM,
                      evidenceDocId: ctx.subject,
                      evidenceQuote: INVOICE_QUOTE,
                      claimBasis: "quoted",
                      confidence: 0.9,
                    },
                  ],
                }),
              ],
              finalText: "Tracked the invoice balance and raised a card for it.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: ROOM_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_create", {
                  title: `Confirm the rehearsal room (${ROOM_MARKER})`,
                  description: "The hold lapses on Friday.",
                  confidence: 0.8,
                  importance: 0.5,
                  docs: [ctx.subject],
                }),
                // Deferred, not resolved — the pulse must count it apart from
                // the open ones without losing it from the total.
                call("open_loop_update", {
                  id: ref("open_loop_create", "loop.id"),
                  state: "snoozed",
                }),
                call("brief_create", {
                  kind: "info",
                  title: `Rehearsal room held until Friday (${ROOM_MARKER})`,
                  description: "Nothing to do until the hold lapses.",
                  citations: [ctx.subject],
                  confidence: 0.8,
                  urgency: 0.3,
                }),
                // A run parked in the future: pending, but not due, so it
                // separates `upcomingRuns` from `queuedRuns`.
                call("schedule_agent_run", {
                  when: FOLLOW_UP_AT,
                  prompt: `Re-check the rehearsal room hold (${ROOM_MARKER}).`,
                  loopId: ref("open_loop_create", "loop.id"),
                }),
              ],
              finalText: "Deferred the room hold and set a day-of check.",
            }),
          },
          {
            flavour: "data.created",
            docTitle: QUIET_DOC.title,
            plan: {
              calls: [],
              finalText: "Routine depot hours; nothing worth tracking.",
            },
          },
          {
            flavour: "feedback.dismissal",
            plan: {
              calls: [
                call("notes_append", {
                  text: `Lesson (${ROOM_MARKER}): a room hold with no action is not worth a card.`,
                }),
              ],
              finalText: "Recorded the not-relevant lesson.",
            },
          },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a scripted day of mixed activity settles into the stores", async () => {
    [invoiceDocId, roomDocId, quietDocId] = (await bench.pushAndSettle([
      INVOICE_DOC,
      ROOM_DOC,
      QUIET_DOC,
    ])) as [string, string, string];

    const settled = await bench.obs.settledRuns("data");
    expect(settled).toHaveLength(3);
    expect(settled.every((r) => r.status === "completed")).toBe(true);

    // The room card is the one the operator throws away — it is the stimulus
    // for the feedback run, and it makes `unreadBriefs` differ from
    // `totalBriefs` for the pulse reconciliation below.
    const roomBrief = (await bench.obs.briefsMatching(ROOM_MARKER))[0];
    expect(roomBrief).toBeDefined();
    const dismissal = await bench.obs.dismissBrief(roomBrief!.id, { reason: "not_relevant" });
    expect(dismissal.state).toBe("dismissed_not_relevant");
    await bench.drainUntilQuiet();

    const loops = await bench.obs.loops();
    expect(loops.items.map((l) => l.state).sort()).toEqual(["open", "snoozed"]);
    expect((await bench.obs.briefs()).items).toHaveLength(2);
    expect(await bench.obs.notes()).toContain(ROOM_MARKER);
  }, 180_000);

  test("the pulse reconciles, field by field, with the rows it summarises", async () => {
    const pulse = await bench.obs.pulse();

    // The pulse's own clock is the request instant; read the truth against a
    // `now` of our own and allow only the fields that cannot move between the
    // two reads (nothing is due, so no run can settle in the gap).
    const now = Date.now();
    const one = (sql: string, ...params: unknown[]): number =>
      (bench.sql.prepare(sql).get(...(params as never[])) as { n: number } | undefined)?.n ?? 0;

    // `queuedRuns` is the DUE backlog, not every pending row: the scheduled
    // follow-up is pending and must NOT be counted here.
    expect(pulse.counts.queuedRuns).toBe(
      one(
        "SELECT COUNT(*) AS n FROM cognition_runs WHERE status='pending' AND next_attempt_at<=?",
        now,
      ),
    );
    expect(pulse.counts.queuedRuns).toBe(0);
    expect(pulse.counts.upcomingRuns).toBe(
      one(
        "SELECT COUNT(*) AS n FROM cognition_runs WHERE status='pending' AND next_attempt_at>?",
        now,
      ),
    );
    // Not vacuous: the day really parked a run in the future.
    expect(pulse.counts.upcomingRuns).toBeGreaterThanOrEqual(1);
    expect(pulse.upcomingRuns.map((r) => r.kind)).toContain("time_based");

    expect(pulse.counts.totalRuns).toBe(one("SELECT COUNT(*) AS n FROM cognition_runs"));
    expect(pulse.counts.totalRuns).toBeGreaterThanOrEqual(5);

    expect(pulse.counts.openLoops).toBe(
      one("SELECT COUNT(*) AS n FROM open_loops WHERE state='open'"),
    );
    expect(pulse.counts.snoozedLoops).toBe(
      one("SELECT COUNT(*) AS n FROM open_loops WHERE state='snoozed'"),
    );
    expect(pulse.counts.totalLoops).toBe(one("SELECT COUNT(*) AS n FROM open_loops"));
    // A snoozed loop is neither open nor gone — the three counters would all
    // agree if the day had only produced open loops.
    expect(pulse.counts.openLoops).toBe(1);
    expect(pulse.counts.snoozedLoops).toBe(1);
    expect(pulse.counts.totalLoops).toBe(2);

    expect(pulse.counts.unreadBriefs).toBe(
      one("SELECT COUNT(*) AS n FROM briefs WHERE state='unread'"),
    );
    expect(pulse.counts.totalBriefs).toBe(one("SELECT COUNT(*) AS n FROM briefs"));
    expect(pulse.counts.unreadBriefs).toBe(1);
    expect(pulse.counts.totalBriefs).toBe(2);

    expect(pulse.counts.failedRuns24h).toBe(
      one(
        "SELECT COUNT(*) AS n FROM cognition_runs WHERE status='failed' AND completed_at>=?",
        now - 24 * 60 * 60 * 1000,
      ),
    );
    expect(pulse.counts.failedRuns24h).toBe(0);

    // The lists beside the counts describe the same runs.
    expect(pulse.runningRuns).toHaveLength(0);
    const settledIds = new Set((await bench.obs.runs({ limit: 200 })).items.map((r) => r.id));
    for (const r of pulse.recentSettledRuns) expect(settledIds.has(r.id)).toBe(true);
  }, 60_000);

  test("the decision view names the run that acted on a document, and what it did", async () => {
    const page = await bench.obs.decisions({ doc: invoiceDocId });
    expect(page.items).toHaveLength(1);
    const decision = page.items[0]!;

    const dataRuns = await bench.obs.settledRuns("data");
    const invoiceRun = dataRuns.find((r) => r.dedupeKey === `data:doc:${invoiceDocId}`);
    expect(invoiceRun).toBeDefined();
    expect(decision.runId).toBe(invoiceRun!.id);
    expect(decision.attempt).toBe(1);
    expect(decision.kind).toBe("data");
    expect(decision.outcome).toBe("completed");
    expect(decision.docId).toBe(invoiceDocId);
    expect(decision.subject).toBe(`doc ${invoiceDocId} (created)`);

    // Mutating calls become actions, in order; reads are counted, not listed.
    expect(decision.actions.map((a) => a.tool)).toEqual([
      "open_loop_create",
      "open_loop_ledger_append",
      "annotate_durable",
      "brief_create",
    ]);
    expect(decision.actions.every((a) => a.ok)).toBe(true);
    expect(decision.actions[0]!.detail).toContain(INVOICE_MARKER);
    // `open_loop_search` is research, not a decision.
    expect(decision.researchToolCalls).toBeGreaterThanOrEqual(1);
    expect(decision.finalText).toContain("Tracked the invoice balance");

    // The run that decided to do nothing still has a decision, with no
    // actions — "did nothing" and "was never asked" must not look alike.
    const quiet = await bench.obs.decisions({ doc: quietDocId });
    expect(quiet.items).toHaveLength(1);
    expect(quiet.items[0]!.actions).toEqual([]);
    expect(quiet.items[0]!.finalText).toContain("nothing worth tracking");

    // The unfiltered view covers every settled run, including the feedback one.
    const all = await bench.obs.decisions();
    expect(all.items.map((d) => d.kind)).toContain("feedback");
  }, 60_000);

  test("every settled run has a transcript carrying its prompt, events and outcome", async () => {
    const runs = (await bench.obs.runs({ limit: 200 })).items.filter((r) => r.status !== "pending");
    expect(runs.length).toBeGreaterThanOrEqual(4);

    const index = await bench.obs.transcripts();
    const indexed = new Set(index.items.map((t) => t.runId));
    for (const run of runs) expect(indexed.has(run.id)).toBe(true);

    for (const run of runs) {
      const refs = await bench.obs.transcripts({ runId: run.id });
      expect(refs.items.length).toBeGreaterThanOrEqual(1);
      const { transcript } = await bench.obs.transcript(refs.items.at(-1)!.fileName);
      expect(transcript.runId).toBe(run.id);
      expect(transcript.kind).toBe(run.kind);
      expect(transcript.outcome).toBe(run.status);
      expect(transcript.prompt).toContain(
        `Loop agent run ${run.id} (kind: ${run.kind}, attempt ${transcript.attempt}).`,
      );
      expect(Array.isArray(transcript.events)).toBe(true);
    }

    // The scripted plan's calls are in the invoice run's event stream, with a
    // result for each — the transcript is the record the decision view folds.
    const invoiceRun = runs.find((r) => r.dedupeKey === `data:doc:${invoiceDocId}`)!;
    const invoiceRefs = await bench.obs.transcripts({ runId: invoiceRun.id });
    const { transcript } = await bench.obs.transcript(invoiceRefs.items.at(-1)!.fileName);
    const started = transcript.events
      .filter((e) => e.type === "agent.tool.start")
      .map((e) => (e.payload as { tool: string }).tool);
    expect(started).toContain("brief_create");
    expect(transcript.events.filter((e) => e.type === "agent.tool.result")).toHaveLength(
      started.length,
    );
  }, 120_000);

  test("every settled run is attributed to a workflow, and spend agrees with itself", async () => {
    const settled = (await bench.obs.runs({ limit: 200 })).items.filter(
      (r) => r.status !== "pending",
    );

    // Attribution is written in the settle transaction, so every settled run
    // has a row and no pending one does.
    const attributed = bench.sql
      .prepare<
        [],
        { run_id: string; workflow_id: string; workflow_version: number }
      >("SELECT run_id, workflow_id, workflow_version FROM cognition_run_attribution")
      .all();
    const byRun = new Map(attributed.map((a) => [a.run_id, a]));
    for (const run of settled) {
      const row = byRun.get(run.id);
      expect(row, `run ${run.id} (${run.kind}) has no attribution row`).toBeDefined();
      expect(row!.workflow_version).toBeGreaterThanOrEqual(1);
    }
    expect(attributed).toHaveLength(settled.length);

    // The workflow ids are the real vocabulary, not the queue kinds.
    const workflows = new Set(attributed.map((a) => a.workflow_id));
    expect(workflows.has("datum-intake")).toBe(true);
    expect(workflows.has("feedback-learning")).toBe(true);
    expect(workflows.has("unrecognized")).toBe(false);
    // A queue kind is not a workflow id — `data` must never leak through.
    expect(workflows.has("data")).toBe(false);

    const mechanism = await bench.obs.mechanismSpend();
    const datum = mechanism.rows.filter((r) => r.mechanism === "datum-intake");
    expect(datum.length).toBeGreaterThan(0);
    const datumRuns = datum.reduce((n, r) => n + r.runs, 0);
    expect(datumRuns).toBe(attributed.filter((a) => a.workflow_id === "datum-intake").length);
    for (const row of mechanism.rows) {
      expect(row.promptTokens).toBeGreaterThan(0);
      expect(row.modelId.length).toBeGreaterThan(0);
    }

    // The day-total surface is the same accounting, aggregated: every
    // mechanism row folds into exactly one day bucket.
    const totals = (await bench.obs.spend()) as {
      items: Array<{ day: string; runs: number; promptTokens: number; completionTokens: number }>;
    };
    const perDay = new Map<string, { runs: number; prompt: number; completion: number }>();
    for (const row of mechanism.rows) {
      const acc = perDay.get(row.day) ?? { runs: 0, prompt: 0, completion: 0 };
      acc.runs += row.runs;
      acc.prompt += row.promptTokens;
      acc.completion += row.completionTokens;
      perDay.set(row.day, acc);
    }
    expect(totals.items.map((i) => i.day).sort()).toEqual([...perDay.keys()].sort());
    for (const item of totals.items) {
      const acc = perDay.get(item.day)!;
      expect(item.runs).toBe(acc.runs);
      expect(item.promptTokens).toBe(acc.prompt);
      expect(item.completionTokens).toBe(acc.completion);
    }

    // And the runs the accounting counted are the runs that executed.
    const countedRuns = totals.items.reduce((n, i) => n + i.runs, 0);
    expect(countedRuns).toBe(settled.filter((r) => r.status === "completed").length);
  }, 60_000);

  test("coverage tallies the settled runs against the source they reasoned over", async () => {
    const coverage = await bench.obs.coverage();
    const pushedSource = bench.sql
      .prepare<[string], { source_id: string }>("SELECT source_id FROM documents WHERE id = ?")
      .get(invoiceDocId)!.source_id;

    const row = coverage.items.find(
      (i) => i.sourceId === pushedSource && i.workflowId === "datum-intake",
    );
    expect(row, "no datum-intake coverage row for the pushed source").toBeDefined();

    // Three documents arrived on that source and three datum runs settled
    // completed, so all three count as processed and none as skipped.
    const datumRunDocs = [invoiceDocId, roomDocId, quietDocId];
    expect(row!.processed).toBe(datumRunDocs.length);
    expect(row!.skipped).toBe(0);
    // `eligible` is a backlog counter the bootstrap lane owns; the real-time
    // lane never selects a backlog, which is what `live` means.
    expect(row!.eligible).toBe(0);
    expect(row!.status).toBe("live");
    expect(row!.promptTokens).toBeGreaterThan(0);

    // Every row's status is the one its own counters imply — the surface must
    // not derive it independently of the store.
    for (const item of coverage.items) {
      const expected =
        item.eligible === 0
          ? "live"
          : item.processed + item.skipped >= item.eligible
            ? "settled"
            : "in-progress";
      expect(item.status, `coverage row ${item.sourceId}/${item.workflowId}`).toBe(expected);
    }
  }, 60_000);

  test("`omnesis brain` renders the state the gateway holds", async () => {
    const loop = (await bench.obs.loopsMatching(INVOICE_MARKER))[0]!;
    const invoiceRun = (await bench.obs.settledRuns("data")).find(
      (r) => r.dedupeKey === `data:doc:${invoiceDocId}`,
    )!;

    const loops = await runCli(bench, ["brain", "loops"]);
    expect(loops.exitCode, loops.stderr).toBe(0);
    expect(loops.stdout).toContain(loop.id);
    expect(loops.stdout).toContain(INVOICE_MARKER);
    expect(loops.stdout).toContain("snoozed");

    const loopShow = await runCli(bench, ["brain", "loop", loop.id]);
    expect(loopShow.exitCode, loopShow.stderr).toBe(0);
    expect(loopShow.stdout).toContain("Balance of four hundred and eighty");
    expect(loopShow.stdout).toContain(INVOICE_DOC.title);
    expect(loopShow.stdout).toContain("Invoice CG-8821 is due");

    const runs = await runCli(bench, ["brain", "runs", "--kind", "data"]);
    expect(runs.exitCode, runs.stderr).toBe(0);
    expect(runs.stdout).toContain(invoiceRun.id.slice(0, 20));
    expect(runs.stdout).toContain("completed");

    const runShow = await runCli(bench, ["brain", "run", invoiceRun.id]);
    expect(runShow.exitCode, runShow.stderr).toBe(0);
    expect(runShow.stdout).toContain(`data:doc:${invoiceDocId}`);
    expect(runShow.stdout).toContain("attempt 1");

    const transcript = await runCli(bench, ["brain", "transcript", invoiceRun.id]);
    expect(transcript.exitCode, transcript.stderr).toBe(0);
    expect(transcript.stdout).toContain(`Loop agent run ${invoiceRun.id}`);
    expect(transcript.stdout).toContain("brief_create");
    expect(transcript.stdout).toContain("Tracked the invoice balance");

    const decisions = await runCli(bench, ["brain", "decisions", "--doc", invoiceDocId]);
    expect(decisions.exitCode, decisions.stderr).toBe(0);
    expect(decisions.stdout).toContain(`doc ${invoiceDocId} (created)`);
    expect(decisions.stdout).toContain("create loop");

    const spend = await runCli(bench, ["brain", "spend", "--by-mechanism"]);
    expect(spend.exitCode, spend.stderr).toBe(0);
    expect(spend.stdout).toContain("Datum intake");

    const dayTotals = await runCli(bench, ["brain", "spend"]);
    expect(dayTotals.exitCode, dayTotals.stderr).toBe(0);
    expect(dayTotals.stdout).toContain("total");

    const notes = await runCli(bench, ["brain", "notes"]);
    expect(notes.exitCode, notes.stderr).toBe(0);
    expect(notes.stdout).toContain(ROOM_MARKER);
  }, 180_000);

  // Destructive, so it runs last: the retention sweep takes every transcript
  // stored so far.
  test("retention evicts the transcript files and leaves the run rows", async () => {
    const before = await bench.obs.transcripts();
    expect(before.items.length).toBeGreaterThan(0);
    const runsBefore = (await bench.obs.runs({ limit: 200 })).items.length;

    // A live config edit kicks the retention sweep, so the window closes
    // without a restart. Only the cognition-transcript phase gets a window —
    // the global `activityRetention` stays unset, so nothing else is pruned.
    await bench.harness.gatewayJson("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ brain: { transcriptRetention: "1s" } }),
    });

    const deadline = Date.now() + 90_000;
    for (;;) {
      const page = await bench.obs.transcripts();
      const remaining = page.items.length;
      if (remaining === 0) break;
      if (Date.now() > deadline) {
        throw new Error(`retention left ${remaining} transcript(s) after 90s`);
      }
      await sleep(1000);
    }

    // The rows outlive their debug artifacts: the queue's own retention is a
    // separate, still-unset window.
    const runsAfter = await bench.obs.runs({ limit: 200 });
    expect(runsAfter.items).toHaveLength(runsBefore);
    // A run whose transcript is gone still resolves — with no attempts.
    const anyRun = runsAfter.items.find((r) => r.status !== "pending")!;
    const detail = await bench.obs.run(anyRun.id);
    expect(detail.transcripts).toHaveLength(0);
    // And the decision view, which is a projection over transcripts, empties
    // with them rather than serving phantoms.
    const decisions = await bench.obs.decisions();
    expect(decisions.items).toEqual([]);
  }, 180_000);
});

// ── the golden snapshot ─────────────────────────────────────────────────────

const GOLDEN_DOC = email({
  externalId: "brain-obs-golden",
  title: "Riverside Estate final balance",
  content: [
    "Hi Alex,",
    "",
    "The final balance for the hall booking is due fourteen days before the date.",
    "We will send a receipt as soon as the transfer clears.",
    "",
    "Riverside Estate",
  ].join("\n"),
});
const GOLDEN_QUOTE = "The final balance for the hall booking is due fourteen days before the date.";
const GOLDEN_CLAIM = "The hall booking's final balance falls due fourteen days before the date.";

/**
 * One pushed document, one run, no ambient corpus.
 *
 * The arc still leaves two documents behind: creating an open loop mirrors it
 * into the corpus under the `open-loops` source (`brain/cognition-authored.ts`).
 * Document ids are random UUIDs, so `snapshotBrainState` canonicalises
 * documents by the columns their author controls — source, then external id —
 * rather than by id, which is what makes the ordinals below reproducible from
 * run to run.
 */
describe("Brain Bench — the golden snapshot", () => {
  let bench: BrainBench;
  let epoch = 0;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      syncSources: false,
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: GOLDEN_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_create", {
                  title: "Pay the hall booking balance",
                  description: "Due fourteen days before the date.",
                  confidence: 0.9,
                  importance: 0.7,
                  docs: [ctx.subject],
                }),
                call("open_loop_ledger_append", {
                  id: ref("open_loop_create", "loop.id"),
                  note: "Balance falls due fourteen days before the booking.",
                }),
                call("annotate_durable", {
                  docId: ctx.subject,
                  claimType: "payment-due",
                  claimText: GOLDEN_CLAIM,
                  evidenceDocId: ctx.subject,
                  evidenceQuote: GOLDEN_QUOTE,
                  confidence: 0.9,
                  claimBasis: "quoted",
                }),
                call("brief_create", {
                  kind: "loop",
                  title: "Hall booking balance is coming due",
                  description: "The final balance is due fourteen days before the date.",
                  citations: [ctx.subject],
                  relatedLoopIds: [ref("open_loop_create", "loop.id")],
                  confidence: 0.9,
                  urgency: 0.5,
                  assertedClaims: [
                    {
                      claimText: GOLDEN_CLAIM,
                      evidenceDocId: ctx.subject,
                      evidenceQuote: GOLDEN_QUOTE,
                      claimBasis: "quoted",
                      confidence: 0.9,
                    },
                  ],
                }),
              ],
              finalText: "Tracked the hall balance and raised a card.",
            }),
          },
        ],
      },
    });
    epoch = Date.now();
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("one datum-intake arc leaves exactly the state the golden records", async () => {
    await bench.pushAndSettle([GOLDEN_DOC]);

    // Creating a loop makes the decay engine owe it a revisit, and that sweep
    // is dirty-gated on the loop row rather than on a clock — so the moment
    // its run appears is a rhythm tick, not something the arc controls.
    // Waiting for the row makes the end state whole: snapshotting before the
    // sweep records a loop nothing will ever re-check, which is not a state
    // the engine actually leaves behind.
    const loopId = (await bench.obs.loops()).items[0]!.id;
    await waitFor(
      `the decay sweep to schedule a revisit for ${loopId}`,
      () => (bench.pendingDedupeKeys().includes(`decay:loop:${loopId}`) ? true : null),
      60_000,
    );

    const snapshot = snapshotBrainState(bench.sql, epoch);

    // Guard rails before the golden, so a diff is read as "the arc changed"
    // rather than "the golden is stale in some unnamed way".
    expect(snapshot.loops).toHaveLength(1);
    expect(snapshot.briefs).toHaveLength(1);
    expect(snapshot.docAnnotations).toHaveLength(1);
    // The datum-intake run, plus the decay revisit it earned.
    expect(snapshot.runs).toHaveLength(2);

    expect(snapshot).toMatchSnapshot();
  }, 180_000);
});
