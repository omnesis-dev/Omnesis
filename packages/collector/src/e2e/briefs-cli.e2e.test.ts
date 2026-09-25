// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Operator-CLI end-to-end coverage for `omnesis brain` (criterion 12):
 * loops list/show, run + transcript access, the per-datum decision
 * view, daily token spend, and the agent-notes print/wipe — all driven
 * as a child-process CLI against a spawned gateway with the Briefs
 * feature ACTIVE (experimental on + a `background-agent` assignment).
 *
 * The engine's own loop/brief creation is exercised by the scripted-
 * backend scorecard lane (S13); here the substrate is seeded directly —
 * loop/run/spend/notes rows into the gateway's SQLite store and
 * transcript JSON files into `<configDir>/briefs/transcripts/` — so the
 * suite asserts the full HTTP + CLI read path deterministically. The
 * notes wipe is the one true mutation and goes through the gateway's
 * writer end-to-end.
 *
 * The inactive-gateway refusal (`omnesis brain` on a gateway without
 * the feature) is covered in cli.e2e.test.ts, whose harness boots
 * without experimental mode.
 */

import "./synth-env.js";

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const CLI_ENTRY = "packages/cli/src/index.ts";
const CLI_TIMEOUT_MS = 30_000;

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Seeded fixture ids/content (all invented, per the privacy rule).
const LOOP_OPEN = "loop_alpha";
const LOOP_DONE = "loop_beta";
const RUN_WITH_TRANSCRIPT = "run_alpha";
const DOC_ID = "doc_invoice_042";
// A still-pending `data` run whose payload is live — proves the runs
// table's DOC / TRIGGER column and `run <id>`'s decoded payload block.
const PENDING_RUN = "run_pending_data";
const PENDING_DOC = "doc_receipt_991";
const NOTES_TEXT = "Maya Reeves prefers reminders the day before, not the day of.";

describe("`omnesis brain` operator CLI (spawned gateway, feature active)", () => {
  let harness: SyntheticE2EHarness;
  let fixtureDir: string;
  let fixturePath: string;

  beforeAll(async () => {
    // `replay` activates the feature without a key or a server, but the gate
    // requires an assignment that can actually build a backend — and the
    // replay factory loads its fixture eagerly. A bare `replay` with no
    // fixture resolves to nothing, so give it a real (minimal) one. The
    // explicit gateway mode opens the feature surface.
    fixtureDir = mkdtempSync(join(tmpdir(), "omnesis-briefs-cli-fixture-"));
    fixturePath = join(fixtureDir, "fixture.jsonl");
    writeFileSync(
      fixturePath,
      `${JSON.stringify({
        afterMs: 0,
        event: {
          type: "agent.message.end",
          payload: { sessionId: "s", messageId: "m", stopReason: "end_turn" },
        },
      })}\n`,
    );
    process.env.OMNESIS_AGENT_FIXTURE = fixturePath;

    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      universe: "e2e-minimal",
      // The queue may soft-fail runs the rhythm enqueues on boot — irrelevant
      // here, the suite asserts on seeded rows only.
      extraInference: { assignments: { "background-agent": "replay" } },
    });
    await harness.start();
    seedSubstrate(harness);
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
    delete process.env.OMNESIS_AGENT_FIXTURE;
    rmSync(fixtureDir, { recursive: true, force: true });
  }, 15_000);

  test("the gateway advertises the feature active on /status", async () => {
    const status = await harness.gatewayJson<{
      briefs?: { active: boolean; modelAssigned: boolean; visible: boolean };
    }>("/status");
    expect(status.briefs).toMatchObject({ active: true, modelAssigned: true, visible: true });
  });

  test("`brain loops` lists seeded loops and honors --state", async () => {
    const all = await runCli(harness, ["brain", "loops"]);
    expect(all.exitCode, all.stderr).toBe(0);
    expect(all.stdout).toContain(LOOP_OPEN);
    expect(all.stdout).toContain("Pay the Stellar Sound invoice");
    expect(all.stdout).toContain(LOOP_DONE);

    const done = await runCli(harness, ["brain", "loops", "--state", "done"]);
    expect(done.exitCode, done.stderr).toBe(0);
    expect(done.stdout).toContain(LOOP_DONE);
    expect(done.stdout).not.toContain(LOOP_OPEN);
  });

  test("the hidden `briefs` compatibility alias still dispatches", async () => {
    const r = await runCli(harness, ["briefs", "loops", "--state", "done"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain(LOOP_DONE);
  });

  test("`brain loop <id>` shows the ledger and attached briefs", async () => {
    const r = await runCli(harness, ["brain", "loop", LOOP_OPEN]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("Pay the Stellar Sound invoice");
    expect(r.stdout).toContain("Invoice spotted in the mail thread."); // ledger note
    expect(r.stdout).toContain(RUN_WITH_TRANSCRIPT); // ledger runId stamp
    expect(r.stdout).toContain("brf_nudge_1"); // attached brief
  });

  test("`brain runs` lists the seeded run; `brain run <id>` shows its transcript ref", async () => {
    const list = await runCli(harness, ["brain", "runs", "--kind", "data"]);
    expect(list.exitCode, list.stderr).toBe(0);
    expect(list.stdout).toContain(RUN_WITH_TRANSCRIPT);
    expect(list.stdout).toContain("completed");
    // A1: the DOC / TRIGGER column surfaces the doc a pending run reacts to.
    expect(list.stdout).toContain("DOC / TRIGGER");
    expect(list.stdout).toContain(PENDING_DOC);
    // A1 addendum: the SCHEDULED column shows when a run acts — the pending
    // run's next_attempt_at (a day out) and the completed run's completion time.
    expect(list.stdout).toContain("SCHEDULED");

    const show = await runCli(harness, ["brain", "run", RUN_WITH_TRANSCRIPT]);
    expect(show.exitCode, show.stderr).toBe(0);
    expect(show.stdout).toContain("kind:         data");
    expect(show.stdout).toContain("120 prompt + 30 completion");
    expect(show.stdout).toContain("attempt 1");
    // The seeded settled row carries a legacy '{}' payload (pre-retention)
    // and no dedupe key, so its decoded payload reads unavailable.
    expect(show.stdout).toContain("payload:");
    expect(show.stdout).toContain("settled before payload retention");
  });

  test("`brain run <id>` decodes a pending run's live payload (A2)", async () => {
    const show = await runCli(harness, ["brain", "run", PENDING_RUN]);
    expect(show.exitCode, show.stderr).toBe(0);
    expect(show.stdout).toContain("status:       pending");
    expect(show.stdout).toContain("payload:");
    expect(show.stdout).toContain(`doc:        ${PENDING_DOC}`);
    expect(show.stdout).toContain("event:      updated");
    expect(show.stdout).toContain("diff:       +1 / -0 lines");
  });

  test("`brain transcript <runId>` prints the prompt and final text; --json emits the raw artifact", async () => {
    const pretty = await runCli(harness, ["brain", "transcript", RUN_WITH_TRANSCRIPT]);
    expect(pretty.exitCode, pretty.stderr).toBe(0);
    expect(pretty.stdout).toContain("Background Cognition Steward run."); // prompt
    expect(pretty.stdout).toContain("open_loop_create"); // tool timeline
    expect(pretty.stdout).toContain("Tracked the invoice as an open loop."); // final text

    const raw = await runCli(harness, ["brain", "transcript", RUN_WITH_TRANSCRIPT, "--json"]);
    expect(raw.exitCode, raw.stderr).toBe(0);
    const transcript = JSON.parse(raw.stdout.slice(raw.stdout.indexOf("{"))) as {
      runId: string;
      payload: { docId: string };
    };
    expect(transcript.runId).toBe(RUN_WITH_TRANSCRIPT);
    expect(transcript.payload.docId).toBe(DOC_ID);
  });

  test("`brain decisions` renders the per-datum decision view and --doc filters it", async () => {
    const all = await runCli(harness, ["brain", "decisions"]);
    expect(all.exitCode, all.stderr).toBe(0);
    expect(all.stdout).toContain(`doc ${DOC_ID} (created)`);
    expect(all.stdout).toContain('create loop "Pay the Stellar Sound invoice"');

    const filtered = await runCli(harness, ["brain", "decisions", "--doc", DOC_ID]);
    expect(filtered.exitCode, filtered.stderr).toBe(0);
    expect(filtered.stdout).toContain(RUN_WITH_TRANSCRIPT);

    const none = await runCli(harness, ["brain", "decisions", "--doc", "doc_no_such"]);
    expect(none.exitCode, none.stderr).toBe(0);
    expect(none.stdout).toContain("No decisions");
  });

  test("`brain spend` shows per-day totals with a grand total", async () => {
    const r = await runCli(harness, ["brain", "spend"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("2026-06-30");
    expect(r.stdout).toContain("2026-07-01");
    // (1100) + (2000 + 200) prompt, (110) + (200 + 20) completion — the
    // per-mechanism buckets aggregate into one row per day.
    expect(r.stdout).toContain("3300");
    expect(r.stdout).toContain("330");
  });

  test("`brain spend --by-mechanism` breaks the totals down per (day, mechanism, model)", async () => {
    const r = await runCli(harness, ["brain", "spend", "--by-mechanism"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("MECHANISM");
    expect(r.stdout).toContain("synthesis");
    expect(r.stdout).toContain("model-y");
    expect(r.stdout).toContain("2000");
  });

  test("`brain notes` prints the file; `--wipe` clears it through the gateway writer", async () => {
    const before = await runCli(harness, ["brain", "notes"]);
    expect(before.exitCode, before.stderr).toBe(0);
    expect(before.stdout).toContain(NOTES_TEXT);

    const wipe = await runCli(harness, ["brain", "notes", "--wipe"]);
    expect(wipe.exitCode, wipe.stderr).toBe(0);
    expect(wipe.stdout).toContain("Agent notes wiped.");

    const after = await runCli(harness, ["brain", "notes"]);
    expect(after.exitCode, after.stderr).toBe(0);
    expect(after.stdout).toContain("(agent notes are empty)");
    expect(after.stdout).not.toContain(NOTES_TEXT);
  });
});

/**
 * Seed the operator-readable substrate directly: loop/brief/run/spend/
 * notes rows into the gateway's store (short transaction; the gateway's
 * writer is idle apart from boot-time rhythm enqueues) and transcript
 * files where the gateway's transcript store reads them. Content is
 * invented. The decay dirty-mark is deliberately NOT bumped, so the
 * seeded open loop doesn't summon decay status-check runs mid-suite.
 */
function seedSubstrate(h: SyntheticE2EHarness): void {
  const now = Date.now();
  const db = new Database(h.getDbPath());
  db.pragma("busy_timeout = 10000");
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO open_loops (id, created_by_run, state, confidence, importance, title,
           description, deadline_json, created_at, last_update)
         VALUES (?, ?, 'open', 0.85, 0.7, 'Pay the Stellar Sound invoice',
           'Invoice 042 arrived; no matching payment yet.', ?, ?, ?)`,
      ).run(
        LOOP_OPEN,
        RUN_WITH_TRANSCRIPT,
        JSON.stringify({ type: "by", date: "2026-07-15" }),
        now - 60_000,
        now - 30_000,
      );
      db.prepare(
        `INSERT INTO open_loops (id, created_by_run, state, confidence, importance, title,
           description, created_at, last_update)
         VALUES (?, 'run_seed', 'done', 0.9, 0.4, 'Reply to the venue booking form', '', ?, ?)`,
      ).run(LOOP_DONE, now - 120_000, now - 90_000);
      db.prepare(`INSERT INTO open_loop_docs (loop_id, doc_id) VALUES (?, ?)`).run(
        LOOP_OPEN,
        DOC_ID,
      );
      db.prepare(
        `INSERT INTO open_loop_ledger (loop_id, run_id, at, note)
         VALUES (?, ?, ?, 'Invoice spotted in the mail thread.')`,
      ).run(LOOP_OPEN, RUN_WITH_TRANSCRIPT, now - 30_000);

      db.prepare(
        `INSERT INTO briefs (id, created_by_run, kind, title, description, confidence, urgency,
           state, created_at, updated_at)
         VALUES ('brf_nudge_1', ?, 'loop', 'An invoice arrived with no matching payment',
           'Invoice 042 from Stellar Sound.', 0.85, 0.6, 'unread', ?, ?)`,
      ).run(RUN_WITH_TRANSCRIPT, now - 30_000, now - 30_000);
      db.prepare(
        `INSERT INTO brief_related_loops (brief_id, loop_id) VALUES ('brf_nudge_1', ?)`,
      ).run(LOOP_OPEN);

      db.prepare(
        `INSERT INTO cognition_runs (id, kind, payload_json, status, attempts, next_attempt_at,
           enqueued_at, last_attempt_at, completed_at, usage_json)
         VALUES (?, 'data', '{}', 'completed', 1, ?, ?, ?, ?, ?)`,
      ).run(
        RUN_WITH_TRANSCRIPT,
        now - 45_000,
        now - 45_000,
        now - 40_000,
        now - 35_000,
        JSON.stringify({ promptTokens: 120, completionTokens: 30 }),
      );

      // A pending `data` run keeps its payload live, so its trigger
      // decodes to the doc it reacts to. Its `next_attempt_at` sits a day
      // out so the live drainer never claims it mid-test (which would
      // settle it and strip the transient snapshot/diff fields).
      db.prepare(
        `INSERT INTO cognition_runs (id, kind, payload_json, status, attempts, next_attempt_at,
           enqueued_at, last_attempt_at, completed_at, usage_json)
         VALUES (?, 'data', ?, 'pending', 0, ?, ?, NULL, NULL, NULL)`,
      ).run(
        PENDING_RUN,
        JSON.stringify({
          docId: PENDING_DOC,
          event: "updated",
          datumAt: now - 10_000,
          diff: "--- a\n+++ b\n+one added line\n context",
        }),
        now + 86_400_000,
        now,
      );

      db.prepare(
        `INSERT INTO cognition_spend (day, mechanism, model_id, runs, prompt_tokens, completion_tokens)
         VALUES ('2026-06-30', 'data', 'model-x', 3, 1100, 110),
                ('2026-07-01', 'data', 'model-x', 4, 2000, 200),
                ('2026-07-01', 'synthesis', 'model-y', 1, 200, 20)`,
      ).run();

      db.prepare(
        `INSERT INTO cognition_notes (id, content, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      ).run(NOTES_TEXT, now);
    })();
  } finally {
    db.close();
  }

  // Transcript files live on the filesystem (like logs), named
  // `<finishedAt>-<runId>-a<attempt>.json` — see briefs/transcripts.ts.
  const dir = join(h.getConfigDir(), "briefs", "transcripts");
  mkdirSync(dir, { recursive: true });
  const finishedAt = now - 35_000;
  writeFileSync(
    join(dir, `${finishedAt}-${RUN_WITH_TRANSCRIPT}-a1.json`),
    JSON.stringify({
      runId: RUN_WITH_TRANSCRIPT,
      attempt: 1,
      kind: "data",
      payload: { docId: DOC_ID, event: "created", datumAt: now - 50_000 },
      startedAt: now - 40_000,
      finishedAt,
      prompt: "Background Cognition Steward run.",
      events: [
        {
          type: "agent.tool.start",
          payload: { toolCallId: "t1", tool: "search", args: { query: "Stellar Sound invoice" } },
        },
        {
          type: "agent.tool.start",
          payload: {
            toolCallId: "t2",
            tool: "open_loop_create",
            args: { title: "Pay the Stellar Sound invoice" },
          },
        },
        {
          type: "agent.tool.result",
          payload: { toolCallId: "t2", result: { kind: "structured" } },
        },
      ],
      finalText: "Tracked the invoice as an open loop.",
      outcome: "completed",
      usage: { promptTokens: 120, completionTokens: 30 },
    }),
    "utf8",
  );
}

async function runCli(harness: SyntheticE2EHarness, args: string[]): Promise<CliResult> {
  try {
    const cliEnv = {
      ...process.env,
      OMNESIS_GATEWAY_URL: harness.gatewayUrl,
      OMNESIS_TOKEN: harness.apiKey,
      // Keep the CLI's TOFU trust state inside this harness. Falling back to
      // the operator's config can feed the child an unrelated certificate.
      OMNESIS_CONFIG_DIR: harness.getConfigDir(),
      // Force non-TTY behaviour so output is plain text we can grep.
      NO_COLOR: "1",
      CI: "1",
    };
    // The in-process collector disables verification for its own synthetic
    // transport. The CLI must instead prove that the harness certificate is
    // sufficient, so never inherit a parent-process TLS bypass.
    delete cliEnv.NODE_TLS_REJECT_UNAUTHORIZED;
    delete cliEnv.NODE_EXTRA_CA_CERTS;
    delete cliEnv.OMNESIS_INSECURE_TLS;
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
