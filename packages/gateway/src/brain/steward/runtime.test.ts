// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Integration tests for the assembled Cognition Steward, zero-token: runs are
 * driven through the REAL run driver with a scripted ChatBackend that
 * invokes the REAL tools (the fake-model-real-tools pattern) —
 * asserting a scripted `open_loop_create` lands a table row + mirror
 * doc stamped with the run id, and that a later run reconciles
 * (search → update) instead of minting a duplicate.
 *
 * Also pins the toolset composition contract: the background agent's
 * interactive tools are EXACTLY the allow-list (no annotation/citation,
 * trigger, or sub-agent tool leaks in even when every such port is
 * wired), the Cognition Steward's own tools are present, and a delegated
 * sub-agent selection (`selectSubagentTools`) drops every mutating tool
 * while keeping the read tools.
 */

import { existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger, type AgentEvent, type ToolResult } from "@omnesis/core";
import { PlanStore, selectSubagentTools } from "@omnesis/agent";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { CognitionRunDriver } from "../run-driver.js";
import { FsCognitionTranscriptStore } from "../transcripts.js";
import { getOpenLoop, listOpenLoopLedger, listOpenLoops } from "../storage/open-loops.js";
import { getBrief, listBriefs } from "../storage/briefs.js";
import { claimDueCognitionRuns } from "../storage/run-queue.js";
import { dismissBriefAndEnqueueFeedback } from "../feedback.js";
import { buildCognitionRunPrompt } from "./prompts.js";
import { createOpenLoopMirror } from "./mirror.js";
import {
  buildCognitionToolset,
  buildCognitionInteractiveOwnTools,
  COGNITION_INTERACTIVE_TOOLS,
  type CognitionToolsetDeps,
} from "./runtime.js";
import { buildCognitionOwnTools, COGNITION_MUTATING_TOOL_NAMES } from "./tools.js";
import type Database from "better-sqlite3";
import type {
  ChatBackend,
  DocumentByUrlPort,
  PersonPort,
  RecordPort,
  SearchPort,
  SqlPort,
  SubagentPort,
  ToolHandle,
  ToolPorts,
  TrailPort,
  TurnInput,
} from "@omnesis/agent";
import type { ClaimedCognitionRun } from "../storage/types.js";

type Db = Database.Database;

const log = createLogger("test").child("loop-agent-runtime");
const NOW = Date.parse("2026-07-02T10:00:00.000Z");

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

/** LIKE-based open-loop search over the mirror documents (see tools.test.ts). */
function fakeSearchPort(db: Db): SearchPort {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async search(input) {
      const types = input.filters?.documentTypes ?? [];
      const rows = db
        .prepare<[string, string, number], { id: string; source_id: string; title: string }>(
          `SELECT id, source_id, title FROM documents
           WHERE json_extract(metadata, '$.documentType') IN (SELECT value FROM json_each(?))
             AND content LIKE ?
           LIMIT ?`,
        )
        .all(JSON.stringify(types), `%${input.query}%`, input.limit ?? 8);
      return {
        query: input.query,
        durationMs: 0,
        results: rows.map((r) => ({
          documentId: r.id,
          sourceType: "system",
          sourceId: r.source_id,
          title: r.title,
        })),
      };
    },
  };
}

/**
 * One scripted step: invoke a (real) tool. `args` may be computed from
 * the results of earlier steps, so a script can search-then-update.
 */
interface ScriptStep {
  tool: string;
  args: (priorResults: ToolResult[]) => unknown;
}

/**
 * A zero-token backend that drives REAL tool execution: for each step it
 * looks the handle up in the turn's tool set and awaits `invoke`, then
 * ends the turn with fixed usage.
 */
function toolCallingBackend(steps: ScriptStep[], invoked: ToolResult[] = []): ChatBackend {
  return {
    name: "scripted",
    model: "scripted-model",
    async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      yield {
        type: "agent.message.start",
        payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
      };
      for (const step of steps) {
        const handle = input.tools.find((t) => t.name === step.tool);
        if (!handle) throw new Error(`scripted step: no tool named ${step.tool}`);
        const result = await handle.invoke(step.args(invoked), {
          sessionId: input.sessionId,
          messageId: input.messageId,
        });
        invoked.push(result);
      }
      yield {
        type: "agent.message.end",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      };
    },
  };
}

/**
 * A claimed run with a payload the workflow vocabulary can decode. The default
 * has to be decodable: a run whose procedure cannot be determined is granted no
 * mutation authority, so an empty payload would silently strip the write tools
 * these tests are about.
 */
const DATA_PAYLOAD = { docId: "doc_1", event: "created", datumAt: 1_700_000_000_000 };

function claimed(overrides: Partial<ClaimedCognitionRun>): ClaimedCognitionRun {
  const base: ClaimedCognitionRun = {
    id: "run_a",
    kind: "data",
    payload: DATA_PAYLOAD,
    payloadJson: JSON.stringify(DATA_PAYLOAD),
    attempts: 1,
    ...overrides,
  };
  // Keep the JSON in step with an overridden payload, so a test that reads
  // either one sees the same run.
  return overrides.payload !== undefined && overrides.payloadJson === undefined
    ? { ...base, payloadJson: JSON.stringify(overrides.payload) }
    : base;
}

function structuredData(result: ToolResult): Record<string, unknown> {
  if (result.kind !== "structured") throw new Error(`not structured: ${JSON.stringify(result)}`);
  return result.data as Record<string, unknown>;
}

describe("assembled Cognition Steward through the real driver", () => {
  let path: string;
  let db: Db;
  let dir: string;
  let transcripts: FsCognitionTranscriptStore;
  let toolsetDeps: CognitionToolsetDeps;

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    dir = mkdtempSync(join(tmpdir(), "omnesis-loop-agent-"));
    transcripts = new FsCognitionTranscriptStore(join(dir, "t"));
    const writeGate = directWriteGate(db);
    const basePorts: ToolPorts = {
      search: fakeSearchPort(db),
      document: { fetch: async () => null },
    };
    toolsetDeps = {
      db,
      writeGate,
      basePorts,
      planStore: new PlanStore(),
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      log,
      experimental: false,
    };
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDriver(backend: ChatBackend): CognitionRunDriver {
    return new CognitionRunDriver({
      resolveBackend: () => backend,
      transcripts,
      log,
      clock: () => NOW,
      buildTools: (run) => buildCognitionToolset(toolsetDeps, run),
      promptBuilder: (run) => buildCognitionRunPrompt(run, { db, clock: () => NOW }),
    });
  }

  test("interactive annotations retain consumption provenance with background annotations disabled", async () => {
    const evidence = "The venue requires a response before Friday.";
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
         source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc_evidence', 'test', 'test', 'evidence', 'Venue request', ?, ?, ?, ?, ?, ?)`,
    ).run(evidence, evidence, NOW, NOW, NOW, NOW);
    toolsetDeps.getAnnotationSettings = () => ({
      enabled: false,
      confidenceCeiling: 0.9,
      basisCeilings: { quoted: 0.9, inferred: 0.7, synthesized: 0.55 },
      confidenceFloor: 0.25,
    });
    expect(buildCognitionToolset(toolsetDeps, claimed({})).map((tool) => tool.name)).not.toContain(
      "annotate_durable",
    );
    const tools = buildCognitionInteractiveOwnTools(toolsetDeps, "interactive_test");
    const invoke = (name: string, args: unknown) =>
      tools
        .find((tool) => tool.name === name)!
        .invoke(args, { sessionId: "test", messageId: "message" });
    const created = await invoke("annotate_durable", {
      docId: "doc_evidence",
      claimType: "response-deadline",
      claimText: evidence,
      evidenceDocId: "doc_evidence",
      evidenceQuote: evidence,
      confidence: 0.8,
      claimBasis: "quoted",
    });
    const annotationId = structuredData(created).id;
    await invoke("annotation_search", { docId: "doc_evidence" });
    const loop = await invoke("open_loop_create", {
      title: "Respond to the venue",
      confidence: 0.8,
      importance: 0.6,
      annotationDependencies: [{ store: "doc", annotationId }],
    });
    expect(loop).toMatchObject({ kind: "structured", resultType: "open_loop.created" });
    expect(db.prepare("SELECT prior_annotation_id FROM cognition_consumption_edges").all()).toEqual(
      [{ prior_annotation_id: annotationId }],
    );
  });

  test("a scripted open_loop_create through the driver lands the table row + mirror doc, stamped with the run id", async () => {
    const invoked: ToolResult[] = [];
    const driver = makeDriver(
      toolCallingBackend(
        [
          {
            tool: "open_loop_create",
            args: () => ({
              title: "Reply to the venue quote",
              description: "A quote arrived and needs an answer.",
              confidence: 0.9,
              importance: 0.7,
              annotationDependencies: [],
            }),
          },
        ],
        invoked,
      ),
    );
    const outcome = await driver.execute(claimed({ id: "run_create" }));
    expect(outcome.ok).toBe(true);
    expect(outcome.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    const loops = listOpenLoops(db);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.createdByRun).toBe("run_create");
    const mirror = db
      .prepare<
        [string],
        { content: string }
      >("SELECT content FROM documents WHERE external_id = ? AND source_id = 'open-loops'")
      .get(loops[0]!.id);
    expect(mirror).toBeDefined();
    expect(mirror!.content).toContain("Reply to the venue quote");
  });

  test("reconcile flow: a later run finds the existing loop via open_loop_search and updates it instead of creating", async () => {
    // Run 1 creates the loop.
    await makeDriver(
      toolCallingBackend([
        {
          tool: "open_loop_create",
          args: () => ({
            title: "Reply to the venue quote",
            description: "Quote awaiting an answer.",
            confidence: 0.9,
            importance: 0.7,
            annotationDependencies: [],
          }),
        },
      ]),
    ).execute(claimed({ id: "run_1" }));

    // Run 2 scripts the reconcile discipline: search, then update the
    // match + append a run-stamped ledger note — no create.
    const invoked: ToolResult[] = [];
    const reconcile = toolCallingBackend(
      [
        { tool: "open_loop_search", args: () => ({ query: "venue quote" }) },
        {
          tool: "open_loop_update",
          args: (prior) => {
            const loops = structuredData(prior[0]!).loops as Array<{ id: string }>;
            if (loops.length !== 1) throw new Error("reconcile search found no loop");
            return { id: loops[0]!.id, state: "done", annotationDependencies: [] };
          },
        },
        {
          tool: "open_loop_ledger_append",
          args: (prior) => {
            const loops = structuredData(prior[0]!).loops as Array<{ id: string }>;
            return { id: loops[0]!.id, note: "reply observed; resolving" };
          },
        },
      ],
      invoked,
    );
    const outcome = await makeDriver(reconcile).execute(claimed({ id: "run_2" }));
    expect(outcome.ok).toBe(true);

    // Exactly one loop — updated, not duplicated — with run_2's stamp on the ledger.
    const loops = listOpenLoops(db);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.state).toBe("done");
    expect(loops[0]!.createdByRun).toBe("run_1");
    const ledger = listOpenLoopLedger(db, loops[0]!.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.runId).toBe("run_2");
    expect(getOpenLoop(db, loops[0]!.id)).not.toBeNull();
  });

  const COGNITION_OWN_TOOL_NAMES = [
    "open_loop_search",
    "open_loop_fetch",
    "open_loop_create",
    "open_loop_update",
    "open_loop_ledger_append",
    "open_loop_delete",
    "brief_list",
    "brief_fetch",
    "brief_create",
    "brief_update",
    "brief_delete",
    "notes_append",
    "notes_rewrite",
    "notes_edit",
    "schedule_agent_run",
    "temporal_annotation_add",
    "temporal_annotation_update",
    "temporal_annotation_delete",
  ] as const;

  test("the toolset composition: interactive tools are EXACTLY the allow-list + own tools, even from a maximally-poisoned ports bag", () => {
    // Wire every interactive-only port. The allow-list must strip their
    // tools by construction — the leak this guards against is an
    // interactive-only tool (annotate / cite_record and friends)
    // reaching the background agent because a port is present.
    toolsetDeps.basePorts = {
      ...toolsetDeps.basePorts,
      documentByUrl: {} as unknown as DocumentByUrlPort,
      person: {} as unknown as PersonPort,
      trail: {} as unknown as TrailPort,
      sql: {} as unknown as SqlPort,
      record: {} as unknown as RecordPort,
      subagent: {} as unknown as SubagentPort,
      // The read-only temporal port IS allow-listed (temporal_query), so it
      // must survive — experimental on so the registry builds it.
      temporal: { query: async () => [] },
      // The read-only reap port IS allow-listed (entity_context) — same deal.
      entityContext: {
        reap: async () => ({
          seed: null,
          loops: [],
          documents: [],
          people: [],
          temporalAnnotations: [],
          truncated: false,
          counts: { loops: 0, documents: 0, people: 0, temporalAnnotations: 0 },
        }),
      },
    };
    toolsetDeps.experimental = true;
    const tools = buildCognitionToolset(toolsetDeps, claimed({ id: "run_x" }));
    const names = tools.map((t) => t.name);
    const nameSet = new Set(names);

    // Every allow-listed interactive read tool is present.
    for (const allowed of COGNITION_INTERACTIVE_TOOLS) {
      expect(nameSet, allowed).toContain(allowed);
    }
    // The interactive citation/annotation family is the regression
    // target: it must never reach the background agent (its results
    // evaporate — nothing materializes a background transcript's
    // annotations into document_links).
    expect(nameSet).not.toContain("annotate_many");
    expect(nameSet).not.toContain("cite_record");
    // Nor trigger management or sub-agent delegation.
    expect(nameSet).not.toContain("spawn_subagent");
    expect(nameSet).not.toContain("join_subagents");
    for (const name of names) expect(name.startsWith("trigger")).toBe(false);

    // The interactive portion (everything that isn't a steward own
    // tool) is EXACTLY the allow-list — no extra interactive tool slipped
    // through. This is the drift guard: a future interactive-only tool
    // reddens this unless it is deliberately added to the allow-list.
    const ownNames = new Set<string>(COGNITION_OWN_TOOL_NAMES);
    const interactive = new Set(names.filter((n) => !ownNames.has(n)));
    expect(interactive).toEqual(new Set(COGNITION_INTERACTIVE_TOOLS));

    // Every one of the Cognition Steward's own tools is present.
    for (const own of COGNITION_OWN_TOOL_NAMES) {
      expect(nameSet, own).toContain(own);
    }
  });

  test("a workflow's mutation authority is withheld by the runtime, not just declared", () => {
    // The point of declaring authority: the verbs a workflow was not granted
    // are absent from the assembled toolset, so the model cannot call them
    // however its prompt drifts.

    // A morning digest composes one card and nothing beneath it.
    const digest = new Set(
      buildCognitionToolset(
        toolsetDeps,
        claimed({ id: "run_dg", kind: "daily", payload: { digest: true, date: "2026-01-02" } }),
      ).map((t) => t.name),
    );
    expect(digest).toContain("brief_create");
    expect(digest).toContain("brief_update");
    expect(digest).not.toContain("open_loop_create");
    expect(digest).not.toContain("annotate_durable");
    // Reads stay broad — narrowing writes must not blind the run.
    expect(digest).toContain("search_many");
    expect(digest).toContain("brief_list");

    // A per-source daily review rides the same queue kind and keeps the
    // default authority, so the split is by workflow and not by kind.
    const review = new Set(
      buildCognitionToolset(
        toolsetDeps,
        claimed({
          id: "run_sr",
          kind: "daily",
          payload: { sourceId: "src_1", dateFrom: "2026-01-02", dateTo: "2026-01-02" },
        }),
      ).map((t) => t.name),
    );
    expect(review).toContain("open_loop_create");
    expect(review).toContain("brief_create");

    // Re-grounding maintains annotation memory and cannot mint an
    // interruption. (The annotation verbs themselves only exist when
    // annotations are enabled, which this fixture leaves off — what matters
    // here is that the brief/loop verbs are gone.)
    const regrounding = new Set(
      buildCognitionToolset(
        toolsetDeps,
        claimed({ id: "run_v", kind: "verification", payload: {} }),
      ).map((t) => t.name),
    );
    expect(regrounding).not.toContain("brief_create");
    expect(regrounding).not.toContain("open_loop_create");
    expect(regrounding).not.toContain("notes_append");
    expect(regrounding).toContain("search_many");
  });

  test("the merge_adjudicate verdict tool is scoped to merge_adjudication runs only", () => {
    // A merge_adjudication run with a well-formed payload carries its one
    // dedicated verdict tool, alongside the usual read tools.
    const adjudication = buildCognitionToolset(
      toolsetDeps,
      claimed({
        id: "run_adj",
        kind: "merge_adjudication",
        payload: { candidateId: "cand_1" },
      }),
    );
    const adjudicationNames = new Set(adjudication.map((t) => t.name));
    expect(adjudicationNames).toContain("merge_adjudicate");
    expect(adjudicationNames).toContain("search_many");
    expect(adjudicationNames).toContain("fetch_many");

    // Any other run kind never sees it.
    const data = buildCognitionToolset(toolsetDeps, claimed({ id: "run_d", kind: "data" }));
    expect(data.map((t) => t.name)).not.toContain("merge_adjudicate");

    // A malformed payload names no candidate to scope the tool to, so the
    // tool is absent (the prompt for such a run instructs a no-op finish).
    const malformed = buildCognitionToolset(
      toolsetDeps,
      claimed({ id: "run_m", kind: "merge_adjudication", payload: { nonsense: true } }),
    );
    expect(malformed.map((t) => t.name)).not.toContain("merge_adjudicate");

    // The interactive own-tools path (`buildOwnTools`) filters over
    // buildCognitionOwnTools' output, so the verdict tool — pushed only by
    // the merge_adjudication branch of buildCognitionToolset — can never
    // reach an interactive session. Assert on the source set directly.
    const own = buildCognitionOwnTools({
      db,
      writeGate: toolsetDeps.writeGate,
      searchPort: toolsetDeps.basePorts.search,
      mirror: toolsetDeps.mirror,
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "interactive_conv_1",
      log,
    });
    expect(own.map((t) => t.name)).not.toContain("merge_adjudicate");

    // And a delegated sub-agent selection drops it — it is a mutating tool.
    const child = selectSubagentTools(adjudication);
    expect(child.map((t) => t.name)).not.toContain("merge_adjudicate");
  });

  test("a delegated sub-agent tool selection drops every mutating tool and keeps the read tools", () => {
    const tools = buildCognitionToolset(toolsetDeps, claimed({ id: "run_x" }));
    const childTools = selectSubagentTools(tools);
    const childNames = new Set(childTools.map((t) => t.name));

    for (const mutating of COGNITION_MUTATING_TOOL_NAMES) {
      expect(childNames, mutating).not.toContain(mutating);
    }
    // Read access survives — including read-only visibility into loops.
    expect(childNames).toContain("search_many");
    expect(childNames).toContain("open_loop_search");
    expect(childNames).toContain("open_loop_fetch");
    expect(childNames).toContain("brief_list");
  });

  /** Seed one open loop with one attached confirm brief via scripted tools. */
  async function seedLoopWithBrief(): Promise<{ loopId: string; briefId: string }> {
    await makeDriver(
      toolCallingBackend([
        {
          tool: "open_loop_create",
          args: () => ({
            title: "Confirm the studio booking",
            description: "A booking request went out; confirmation pending.",
            confidence: 0.8,
            importance: 0.6,
            annotationDependencies: [],
          }),
        },
        {
          tool: "brief_create",
          args: (prior) => {
            const loop = structuredData(prior[0]!).loop as { id: string };
            return {
              kind: "loop",
              title: "Studio booking looks handled — confirm?",
              confidence: 0.8,
              urgency: 0.5,
              relatedLoopIds: [loop.id],
              annotationDependencies: [],
            };
          },
        },
      ]),
    ).execute(claimed({ id: "run_seed" }));
    const loops = listOpenLoops(db);
    const briefs = listBriefs(db);
    expect(loops).toHaveLength(1);
    expect(briefs).toHaveLength(1);
    return { loopId: loops[0]!.id, briefId: briefs[0]!.id };
  }

  test("snooze round-trip through the real driver: dismissal hides the brief, the feedback run honours the picked time, the brief returns to unread", async () => {
    const { briefId } = await seedLoopWithBrief();
    const until = NOW + 86_400_000;

    // The user snoozes ("tomorrow"): synchronous flip + feedback-run enqueue.
    const res = dismissBriefAndEnqueueFeedback(
      db,
      { briefId, reason: "snoozed", snoozeUntil: until, feedbackRunId: "run_fb" },
      NOW,
    );
    expect(res.outcome).toBe("dismissed");
    // Invisible now: dismissed_snoozed is outside the feed's unread/read selection.
    expect(getBrief(db, briefId)?.state).toBe("dismissed_snoozed");

    // Claim the run the way the drainer does; its prompt carries the signal.
    const [run] = claimDueCognitionRuns(db, { now: NOW });
    expect(run).toMatchObject({ id: "run_fb", kind: "feedback" });
    const prompt = buildCognitionRunPrompt(run!, { db, clock: () => NOW });
    expect(prompt).toContain("dismissed_snoozed");
    expect(prompt).toContain(new Date(until).toISOString());

    // The feedback run honours the picked time via brief_update; the
    // engine returns the brief to unread with next_show gating display.
    const outcome = await makeDriver(
      toolCallingBackend([
        {
          tool: "brief_update",
          args: () => ({
            id: briefId,
            nextShow: new Date(until).toISOString(),
            annotationDependencies: [],
          }),
        },
      ]),
    ).execute(run!);
    expect(outcome.ok).toBe(true);
    const after = getBrief(db, briefId)!;
    expect(after.state).toBe("unread");
    expect(after.nextShow).toBe(until);
  });

  test("already-handled through the real driver: the feedback run closes the related loop; its non-terminal briefs cascade, the dismissed one stays terminal", async () => {
    const { loopId, briefId } = await seedLoopWithBrief();
    // A second, still-unread brief on the same loop — cascade fodder.
    await makeDriver(
      toolCallingBackend([
        {
          tool: "brief_create",
          args: () => ({
            kind: "loop",
            title: "Reminder: studio booking still open",
            confidence: 0.7,
            urgency: 0.4,
            relatedLoopIds: [loopId],
            // Deliberate sibling on one loop — cascade fodder for the
            // retract assertion below; bypass the one-card-per-loop guard.
            force: true,
            annotationDependencies: [],
          }),
        },
      ]),
    ).execute(claimed({ id: "run_seed2" }));
    const siblingId = listBriefs(db).find((b) => b.id !== briefId)!.id;

    const res = dismissBriefAndEnqueueFeedback(
      db,
      { briefId, reason: "already_handled", feedbackRunId: "run_fb", feedback: null },
      NOW,
    );
    expect(res.outcome).toBe("dismissed");

    const [run] = claimDueCognitionRuns(db, { now: NOW });
    const prompt = buildCognitionRunPrompt(run!, { db, clock: () => NOW });
    expect(prompt).toContain("dismissed_already_handled");

    // The feedback run closes (deletes) the related loop.
    const outcome = await makeDriver(
      toolCallingBackend([{ tool: "open_loop_delete", args: () => ({ id: loopId }) }]),
    ).execute(run!);
    expect(outcome.ok).toBe(true);

    // Loop gone; the unread sibling cascaded away with it; the dismissed
    // brief survives in its terminal state (never re-surfaces) with no
    // dangling loop edges.
    expect(getOpenLoop(db, loopId)).toBeNull();
    expect(getBrief(db, siblingId)).toBeNull();
    const terminal = getBrief(db, briefId)!;
    expect(terminal.state).toBe("dismissed_already_handled");
    expect(terminal.relatedLoopIds).toEqual([]);
  });

  test("tool errors don't fail the run: an invalid scripted call surfaces as an error result the model can react to", async () => {
    const invoked: ToolResult[] = [];
    const driver = makeDriver(
      toolCallingBackend(
        [{ tool: "open_loop_create", args: () => ({ title: "", confidence: 2, importance: 0.5 }) }],
        invoked,
      ),
    );
    const outcome = await driver.execute(claimed({ id: "run_bad" }));
    expect(outcome.ok).toBe(true); // the TURN completed; the tool refused
    expect(invoked[0]).toMatchObject({ kind: "error", code: "invalid_args" });
    expect(listOpenLoops(db)).toHaveLength(0);
  });

  // The wiring test the unit tests cannot stand in for: a lane resolved in
  // run-payloads and a gate honoured in brief-judge prove nothing unless the
  // lane actually travels from the claimed run into brief_create.
  test("the run's lane reaches brief_create — a digest never consults the judge, a datum run always does", async () => {
    const judged: string[] = [];
    const judgingDeps: CognitionToolsetDeps = {
      ...toolsetDeps,
      getBriefJudge: () => ({
        judge: async (candidate) => {
          judged.push(candidate.lane ?? "(none)");
          return { decision: "hold" as const, reason: "held by the stub" };
        },
      }),
    };
    const create = async (run: ClaimedCognitionRun) => {
      const tool = buildCognitionToolset(judgingDeps, run).find((t) => t.name === "brief_create")!;
      return tool.invoke(
        {
          kind: "info",
          title: "t",
          description: "d",
          confidence: 0.5,
          urgency: 0.5,
          annotationDependencies: [],
        },
        { sessionId: "S", messageId: "M" },
      );
    };

    const digest = await create(
      claimed({ id: "run_digest", kind: "daily", payload: { digest: true, date: "2026-07-02" } }),
    );
    expect(judged).toEqual([]);
    expect((structuredData(digest)["brief"] as { id?: string }).id).toBeTypeOf("string");

    const datum = await create(claimed({ id: "run_datum", kind: "data" }));
    expect(judged).toEqual(["reactive"]);
    expect(structuredData(datum)["reason"]).toBe("held by the stub");

    const mayDay = await create(
      claimed({ id: "run_mayday", kind: "daily", payload: { mayDay: true, date: "2026-07-02" } }),
    );
    expect(judged).toEqual(["reactive", "lookahead"]);
    expect(structuredData(mayDay)["reason"]).toBe("held by the stub");

    await create(
      claimed({
        id: "run_sched",
        kind: "time_based",
        payload: { prompt: "re-verify before it surfaces", loopId: "loop_x" },
      }),
    );
    await create(
      claimed({
        id: "run_notice",
        kind: "synthesis",
        payload: { focus: "noticing", date: "2026-07-02" },
      }),
    );
    expect(judged).toEqual(["reactive", "lookahead", "dated_reminder", "noticing"]);
  });
});
