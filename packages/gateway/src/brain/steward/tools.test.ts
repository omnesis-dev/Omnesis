// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the Cognition Steward's own tools, over a real SQLite store +
 * the direct write gate: mutations land in the tables, every loop
 * mutation keeps the searchable mirror document in sync, references to
 * unknown/deleted documents are dropped-and-reported, the notes cap is
 * enforced at the tool boundary, and every argument object is validated
 * (zod-at-boundary).
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger, TEMPORAL_KINDS } from "@omnesis/core";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { getOpenLoop, listOpenLoopLedger } from "../storage/open-loops.js";
import { getBrief, listShowableBriefs } from "../storage/briefs.js";
import { readCognitionNotes } from "../storage/notes.js";
import {
  claimDueCognitionRuns,
  completeCognitionRun,
  enqueueCognitionRun,
  getCognitionRun,
  listCognitionRuns,
} from "../storage/run-queue.js";
import {
  notesCompactionRunDedupeKey,
  SCHEDULED_INSTRUCTION_MAX_CHARS,
  SCHEDULED_INSTRUCTION_REQUEST_MAX_CHARS,
} from "../run-payloads.js";
import { createOpenLoopMirror } from "./mirror.js";
import {
  buildCognitionOwnTools,
  COGNITION_MUTATING_TOOL_NAMES,
  type CognitionToolDeps,
} from "./tools.js";
import type Database from "better-sqlite3";
import type { SearchPort, TemporalReadPort, ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";

type Db = Database.Database;

const log = createLogger("test").child("loop-agent-tools");
const CTX = { sessionId: "S", messageId: "M" };

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function sourceDoc(externalId: string, content: string): DocumentInput {
  return {
    providerId: ProviderId("google"),
    sourceId: SourceId("gmail-test"),
    externalId,
    title: `Message ${externalId}`,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    sourceCreatedAt: "2026-07-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
    metadata: { documentType: "email" },
  };
}

function docIdByExternal(db: Db, externalId: string): string | null {
  const row = db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId);
  return row?.id ?? null;
}

/**
 * A LIKE-based stand-in for the search pipeline that honours the
 * documentTypes filter — enough to prove the tools scope their queries
 * to `open-loop` and to drive the reconcile flow.
 */
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

function findTool(tools: ToolHandle[], name: string): ToolHandle {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool named ${name}`);
  // Most tests in this file predate annotation provenance and exercise
  // unrelated tool behavior, so make their explicit judgment `[]` centrally.
  // grounding-teeth.test.ts invokes the raw handles to pin the required field
  // and output-specific selection behavior for all four mutation tools.
  if (["open_loop_create", "open_loop_update", "brief_create", "brief_update"].includes(name)) {
    return {
      ...t,
      invoke(args, context) {
        const withDependencies =
          args !== null && typeof args === "object" && !Array.isArray(args)
            ? { annotationDependencies: [], ...args }
            : args;
        return t.invoke(withDependencies, context);
      },
    };
  }
  return t;
}

function structured(result: ToolResult): { resultType: string; data: Record<string, unknown> } {
  if (result.kind !== "structured") {
    throw new Error(`expected a structured result, got ${JSON.stringify(result)}`);
  }
  return { resultType: result.resultType, data: result.data as Record<string, unknown> };
}

describe("Cognition Steward tools", () => {
  let path: string;
  let db: Db;
  let tools: ToolHandle[];
  let nowMs: number;
  let seq: number;

  function buildTools(overrides: Partial<CognitionToolDeps> = {}): ToolHandle[] {
    const writeGate = directWriteGate(db);
    return buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: fakeSearchPort(db),
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => nowMs,
      runId: "run_test_1",
      idGen: () => `id${++seq}`,
      log,
      ...overrides,
    });
  }

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    nowMs = Date.parse("2026-07-02T10:00:00.000Z");
    seq = 0;
    tools = buildTools();
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  async function createLoop(extra: Record<string, unknown> = {}): Promise<string> {
    const result = await findTool(tools, "open_loop_create").invoke(
      {
        title: "Reply to the venue quote",
        description: "Waiting on a reply since Monday.",
        confidence: 0.9,
        importance: 0.7,
        annotationDependencies: [],
        ...extra,
      },
      CTX,
    );
    const { data } = structured(result);
    return (data.loop as { id: string }).id;
  }

  test("deadline reconciliation reports temporal overlaps and linked loops together", async () => {
    const when = "2031-04-10";
    const loopId = await createLoop({ deadline: { type: "by", date: when } });
    const tool = findTool(tools, "temporal_annotation_add");
    const existing = structured(
      await tool.invoke({ when, kind: "event", sentence: "The workshop opens." }, CTX),
    );
    const refusal = structured(
      await tool.invoke(
        { when, kind: "deadline", sentence: "The payment is due.", loopIds: [loopId] },
        CTX,
      ),
    );
    expect(refusal.resultType).toBe("temporal_annotation.overlap_candidates");
    expect(refusal.data.candidates).toEqual([expect.objectContaining({ id: existing.data.id })]);
    expect(refusal.data.loopDeadlineCandidates).toEqual([expect.objectContaining({ id: loopId })]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM temporal_annotations").get()).toEqual({ n: 1 });
  });

  test.each([
    "2031-04-10T17:00:00Z",
    { type: "by", date: "2031-04-10T17:00:00Z" },
    { type: "on_day", date: "2031-04-10" },
  ])("reconciles matching linked loop deadlines before writing: %j", async (deadline) => {
    const loopId = await createLoop({ deadline });
    const when = typeof deadline === "string" ? deadline : deadline.date;
    const tool = findTool(tools, "temporal_annotation_add");
    const args = {
      when,
      kind: "deadline",
      sentence: "The booking payment is due.",
      loopIds: [loopId, loopId, "missing"],
    };
    const refusal = structured(await tool.invoke(args, CTX));
    expect(refusal.resultType).toBe("temporal_annotation.overlap_candidates");
    expect(refusal.data.loopDeadlineCandidates).toEqual([
      { id: loopId, title: "Reply to the venue quote", deadline },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM temporal_annotations").get()).toEqual({ n: 0 });
    // Same interval does not prove semantic duplication: the caller can
    // explicitly confirm a separate fact, retaining the loop backlink.
    const added = structured(
      await tool.invoke(
        { ...args, force: true, sentence: "An independently established access permit expires." },
        CTX,
      ),
    );
    expect(added.resultType).toBe("temporal_annotation.added");
    expect(db.prepare("SELECT COUNT(*) AS n FROM temporal_annotations").get()).toEqual({ n: 1 });
  });

  test.each([
    { deadline: "2031-04-10T17:00:00Z", kind: "event", when: "2031-04-10T17:00:00Z", linked: true },
    {
      deadline: "2031-04-10T17:00:00Z",
      kind: "deadline",
      when: "2031-04-11T17:00:00Z",
      linked: true,
    },
    {
      deadline: "2031-04-10T17:00:00Z",
      kind: "deadline",
      when: "2031-04-10T17:00:00Z",
      linked: false,
    },
    { deadline: { type: "any_time" }, kind: "deadline", when: "2031-04-10", linked: true },
    { deadline: "when convenient", kind: "deadline", when: "2031-04-10", linked: true },
  ])(
    "does not conflate independent temporal facts with loop deadlines: %j",
    async ({ deadline, kind, when, linked }) => {
      const loopId = await createLoop({ deadline });
      const result = structured(
        await findTool(tools, "temporal_annotation_add").invoke(
          {
            when,
            kind,
            sentence: "An independent dated fact.",
            loopIds: linked ? [loopId] : ["missing"],
          },
          CTX,
        ),
      );
      expect(result.resultType).toBe("temporal_annotation.added");
    },
  );

  test("open_loop_create writes the table row, stamps the run id, and mirrors a searchable document", async () => {
    const loopId = await createLoop();
    const row = getOpenLoop(db, loopId);
    expect(row).not.toBeNull();
    expect(row!.createdByRun).toBe("run_test_1");
    expect(row!.state).toBe("open");
    // The mirror document exists under the open-loops system source.
    const mirrorId = docIdByExternal(db, loopId);
    expect(mirrorId).not.toBeNull();
    const mirror = db
      .prepare<
        [string],
        { content: string; source_id: string }
      >("SELECT content, source_id FROM documents WHERE id = ?")
      .get(mirrorId!);
    expect(mirror!.source_id).toBe("open-loops");
    expect(mirror!.content).toContain("Reply to the venue quote");
  });

  test("open_loop_create resolves person refs (emails → person ids) and reports drops", async () => {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen,
          created_at, updated_at)
       VALUES ('per_maya', 'Maya Reeves', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO person_aliases (person_id, alias, alias_type, source_id, created_at)
       VALUES ('per_maya', 'maya@example.com', 'email', 'test', '2026-01-01')`,
    ).run();
    const result = await findTool(tools, "open_loop_create").invoke(
      {
        title: "Reply to the venue quote",
        confidence: 0.8,
        importance: 0.5,
        // An email resolves to its person; an unknown email is dropped, not stored.
        actors: ["maya@example.com"],
        involved: ["per_maya", "ghost@example.com"],
      },
      CTX,
    );
    const { data } = structured(result);
    const loop = data.loop as { id: string; actors: string[]; involved: string[] };
    expect(loop.actors).toEqual(["per_maya"]);
    expect(loop.involved).toEqual(["per_maya"]);
    expect(data.droppedInvolved).toEqual(["ghost@example.com"]);
    expect(data.droppedActors).toBeUndefined();
    // The stored row matches what the model was told.
    const row = getOpenLoop(db, loop.id);
    expect(row?.actors).toEqual(["per_maya"]);
    expect(row?.involved).toEqual(["per_maya"]);
  });

  test("temporal_annotation_add backlinks known loops + people, drops unknown loops, reports both", async () => {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen,
          created_at, updated_at)
       VALUES ('per_maya', 'Maya Reeves', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run();
    const loopId = await createLoop();
    const result = await findTool(tools, "temporal_annotation_add").invoke(
      {
        when: "2026-07-20",
        sentence: "the deposit is due",
        kind: "deadline",
        loopIds: [loopId, "olp_missing"],
        personIds: ["per_maya", "per_ghost"],
      },
      CTX,
    );
    const { resultType, data } = structured(result);
    expect(resultType).toBe("temporal_annotation.added");
    expect(data.loopIds).toEqual([loopId]);
    expect(data.personIds).toEqual(["per_maya"]);
    expect(data.droppedLoopIds).toEqual(["olp_missing"]);
    expect(data.droppedPersonIds).toEqual(["per_ghost"]);
    // The loop now surfaces the entry inline on fetch (the loop→deadline backlink).
    const fetched = await findTool(tools, "open_loop_fetch").invoke({ id: loopId }, CTX);
    const fetchedData = structured(fetched).data as {
      temporalAnnotations: Array<{ sentence: string; kind: string }>;
    };
    expect(fetchedData.temporalAnnotations).toHaveLength(1);
    expect(fetchedData.temporalAnnotations[0]!.sentence).toBe("the deposit is due");
    expect(fetchedData.temporalAnnotations[0]!.kind).toBe("deadline");
  });

  test("temporal_annotation_add requires evidence when documentIds are supplied", async () => {
    // A document-derived entry without a grounding quote can neither survive
    // source edits deliberately nor be retired honestly — the invalidator
    // would have nothing to re-check.
    const refused = await findTool(tools, "temporal_annotation_add").invoke(
      {
        when: "2026-07-21",
        sentence: "the audit is booked",
        kind: "appointment",
        documentIds: ["doc-x"],
      },
      CTX,
    );
    expect(refused).toMatchObject({
      kind: "error",
      code: "invalid_args",
      message: expect.stringContaining("evidence {docId, quote}"),
    });
    // A pure scheduling entry with no documentIds stays evidence-free.
    const scheduled = await findTool(tools, "temporal_annotation_add").invoke(
      { when: "2026-07-22", sentence: "quiet hold for the studio move", kind: "reminder" },
      CTX,
    );
    expect(structured(scheduled).resultType).toBe("temporal_annotation.added");
  });

  test("temporal_annotation_update refuses new doc links on an ungrounded entry without evidence", async () => {
    // Without this, add-without-docs followed by update-with-docs would mint
    // exactly the unverifiable doc-linked shape the add guard forbids.
    const added = await findTool(tools, "temporal_annotation_add").invoke(
      { when: "2026-07-25", sentence: "annexe walkthrough pencilled in", kind: "appointment" },
      CTX,
    );
    const { data } = structured(added);
    const id = (data as { id: string }).id;

    const refused = await findTool(tools, "temporal_annotation_update").invoke(
      { annotationId: id, documentIds: ["doc-y"] },
      CTX,
    );
    expect(refused).toMatchObject({
      kind: "error",
      code: "invalid_args",
      message: expect.stringContaining("evidence {docId, quote}"),
    });
  });

  test("temporal annotation mutation tools reject immutable projection ids at the boundary", async () => {
    for (const [toolName, args] of [
      ["temporal_annotation_update", { annotationId: "tp_source_fact", sentence: "changed" }],
      ["temporal_annotation_delete", { annotationId: "tp_source_fact" }],
    ] as const) {
      const result = await findTool(tools, toolName).invoke(args, CTX);
      expect(result).toMatchObject({
        kind: "error",
        code: "invalid_args",
        message: expect.stringContaining("immutable"),
      });
    }
  });

  test("open_loop_update resolves person refs like create", async () => {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen,
          created_at, updated_at)
       VALUES ('per_jamie', 'Jamie Lopez', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO person_aliases (person_id, alias, alias_type, source_id, created_at)
       VALUES ('per_jamie', 'jamie@example.com', 'email', 'test', '2026-01-01')`,
    ).run();
    const loopId = await createLoop();
    const result = await findTool(tools, "open_loop_update").invoke(
      { id: loopId, actors: ["jamie@example.com", "nobody@example.com"] },
      CTX,
    );
    const { data } = structured(result);
    expect((data.loop as { actors: string[] }).actors).toEqual(["per_jamie"]);
    expect(data.droppedActors).toEqual(["nobody@example.com"]);
    expect(getOpenLoop(db, loopId)?.actors).toEqual(["per_jamie"]);
  });

  test("open_loop_create drops unknown doc ids and reports them", async () => {
    upsertDocuments(db, [sourceDoc("msg_1", "quote attached")]);
    const known = docIdByExternal(db, "msg_1")!;
    const result = await findTool(tools, "open_loop_create").invoke(
      {
        title: "Reply to the venue quote",
        confidence: 0.8,
        importance: 0.5,
        docs: [known, "doc_gone"],
      },
      CTX,
    );
    const { data } = structured(result);
    expect((data.loop as { docs: string[] }).docs).toEqual([known]);
    expect(data.droppedDocIds).toEqual(["doc_gone"]);
  });

  test("open_loop_update with decayCheckPassed stamps last_decay_check and grows the back-off counter", async () => {
    const loopId = await createLoop();
    nowMs += 5_000;
    const result = await findTool(tools, "open_loop_update").invoke(
      { id: loopId, importance: 0.3, decayCheckPassed: true },
      CTX,
    );
    structured(result);
    const row = getOpenLoop(db, loopId);
    expect(row?.lastDecayCheck).toBe(nowMs);
    expect(row?.decayCheckCount).toBe(1);
    expect(row?.importance).toBe(0.3);
    // A plain update afterwards is reinforcement: the counter resets.
    await findTool(tools, "open_loop_update").invoke({ id: loopId, importance: 0.5 }, CTX);
    const after = getOpenLoop(db, loopId);
    expect(after?.decayCheckCount).toBe(0);
    expect(after?.lastDecayCheck).toBe(nowMs); // the stamp itself survives
  });

  test("open_loop_update mutates fields and re-projects the mirror", async () => {
    const loopId = await createLoop();
    const result = await findTool(tools, "open_loop_update").invoke(
      { id: loopId, state: "done", description: "They confirmed by email." },
      CTX,
    );
    const { data } = structured(result);
    expect((data.loop as { state: string }).state).toBe("done");
    const mirror = db
      .prepare<[string], { content: string }>("SELECT content FROM documents WHERE external_id = ?")
      .get(loopId);
    expect(mirror!.content).toContain("State: done");
    expect(mirror!.content).toContain("They confirmed by email.");
  });

  test("open_loop_ledger_append stamps the run id and lands in the mirror's history", async () => {
    const loopId = await createLoop();
    await findTool(tools, "open_loop_ledger_append").invoke(
      { id: loopId, note: "follow-up email observed" },
      CTX,
    );
    const ledger = listOpenLoopLedger(db, loopId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.runId).toBe("run_test_1");
    const mirror = db
      .prepare<[string], { content: string }>("SELECT content FROM documents WHERE external_id = ?")
      .get(loopId);
    expect(mirror!.content).toContain("follow-up email observed");
  });

  test("open_loop_delete enforces the deletion invariant and removes the mirror", async () => {
    const loopId = await createLoop();
    const briefResult = await findTool(tools, "brief_create").invoke(
      {
        kind: "loop",
        title: "Venue quote needs a reply",
        confidence: 0.9,
        urgency: 0.5,
        relatedLoopIds: [loopId],
      },
      CTX,
    );
    const briefId = (structured(briefResult).data.brief as { id: string }).id;

    const result = await findTool(tools, "open_loop_delete").invoke({ id: loopId }, CTX);
    const { data } = structured(result);
    expect(data.deletedBriefIds).toEqual([briefId]);
    expect(getOpenLoop(db, loopId)).toBeNull();
    expect(getBrief(db, briefId)).toBeNull();
    expect(docIdByExternal(db, loopId)).toBeNull();
  });

  test("open_loop_search reaches only open-loop documents and returns loops with attached-brief summaries", async () => {
    // A source email containing the same phrase must NOT surface.
    upsertDocuments(db, [sourceDoc("msg_1", "venue quote discussion")]);
    const loopId = await createLoop();
    await findTool(tools, "brief_create").invoke(
      {
        kind: "loop",
        title: "Quote pending",
        confidence: 0.8,
        urgency: 0.4,
        relatedLoopIds: [loopId],
      },
      CTX,
    );
    const result = await findTool(tools, "open_loop_search").invoke({ query: "venue quote" }, CTX);
    const { data } = structured(result);
    const loops = data.loops as Array<{ id: string; attachedBriefs: Array<{ title: string }> }>;
    expect(loops).toHaveLength(1);
    expect(loops[0]!.id).toBe(loopId);
    expect(loops[0]!.attachedBriefs.map((b) => b.title)).toEqual(["Quote pending"]);
  });

  test("open_loop_search sees a just-created loop even when the pipeline knows nothing (fresh-reads overlay), without duplicating pipeline hits", async () => {
    // A pipeline that never returns anything — the stale-snapshot /
    // not-yet-indexed worst case for a loop minted moments ago.
    const blindTools = buildTools({
      searchPort: {
        // eslint-disable-next-line @typescript-eslint/require-await
        async search(input) {
          return { query: input.query, durationMs: 0, results: [] };
        },
      },
    });
    const created = await findTool(blindTools, "open_loop_create").invoke(
      {
        title: "Pay invoice INV-2041 from Cedar Grove Supplies",
        confidence: 0.9,
        importance: 0.8,
      },
      CTX,
    );
    const loopId = (structured(created).data.loop as { id: string }).id;

    const blind = structured(
      await findTool(blindTools, "open_loop_search").invoke({ query: "INV-2041" }, CTX),
    );
    expect((blind.data.loops as Array<{ id: string }>).map((l) => l.id)).toEqual([loopId]);

    // With a pipeline that DOES return the same loop's mirror document,
    // the overlay + pipeline union must not duplicate it.
    const result = structured(
      await findTool(tools, "open_loop_search").invoke({ query: "INV-2041" }, CTX),
    );
    expect((result.data.loops as Array<{ id: string }>).map((l) => l.id)).toEqual([loopId]);
  });

  describe("open_loop_search identity reconcile (graph-based candidates)", () => {
    function seedPerson(id: string): void {
      db.prepare(
        `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen,
            created_at, updated_at, interaction_score_recent)
         VALUES (?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', 0.5)`,
      ).run(id, id);
    }
    function linkDocPerson(docId: string, personId: string): void {
      db.prepare(
        "INSERT INTO document_people (document_id, person_id, role) VALUES (?, ?, 'from')",
      ).run(docId, personId);
    }

    test("a data-run seed doc sharing a person surfaces that loop FIRST with a person tag, despite zero token overlap", async () => {
      // The arriving datum shares person `per_maya` with an existing loop whose
      // wording has nothing in common with the query.
      seedPerson("per_maya");
      upsertDocuments(db, [sourceDoc("msg_seed", "an entirely unrelated message body")]);
      const seedDocId = docIdByExternal(db, "msg_seed")!;
      linkDocPerson(seedDocId, "per_maya");
      await createLoop({ title: "Reply to the venue quote", actors: ["per_maya"] });

      const seededTools = buildTools({ seedDocIds: [seedDocId] });
      // A query that matches the loop neither lexically nor semantically.
      const result = structured(
        await findTool(seededTools, "open_loop_search").invoke({ query: "zzyzx quorum" }, CTX),
      );
      const loops = result.data.loops as Array<{
        title: string;
        matchedBy?: string[];
      }>;
      expect(loops).toHaveLength(1);
      expect(loops[0]!.title).toBe("Reply to the venue quote");
      expect(loops[0]!.matchedBy).toContain("person:per_maya");
    });

    test("a loop matched by BOTH identity and lexical merges its matchedBy tags", async () => {
      seedPerson("per_maya");
      upsertDocuments(db, [sourceDoc("msg_seed2", "unrelated body text")]);
      const seedDocId = docIdByExternal(db, "msg_seed2")!;
      linkDocPerson(seedDocId, "per_maya");
      // The loop shares the person AND a title token with the query.
      await createLoop({ title: "Reply to the venue quote", actors: ["per_maya"] });

      const seededTools = buildTools({ seedDocIds: [seedDocId] });
      const result = structured(
        await findTool(seededTools, "open_loop_search").invoke({ query: "venue" }, CTX),
      );
      const loops = result.data.loops as Array<{ matchedBy?: string[] }>;
      expect(loops).toHaveLength(1);
      // Identity fixed its position and tag; the lexical pass merged `lexical`.
      expect(loops[0]!.matchedBy).toContain("person:per_maya");
      expect(loops[0]!.matchedBy).toContain("lexical");
    });

    test("deadline-only identity matches rank below lexical and cannot crowd out a marker match", async () => {
      // The buried-loop flooding case: the seed datum's date sits near the
      // deadlines of MANY unrelated loops (deadline-proximity fires for all
      // of them, no shared person/thread/doc), while the query's exact
      // marker matches one OLD loop lexically. The marker loop must surface
      // — first — instead of being sliced off by the pile of weak matches.
      upsertDocuments(db, [sourceDoc("msg_flood_seed", "contract fully executed notice")]);
      const seedDocId = docIdByExternal(db, "msg_flood_seed")!;

      // The old target loop: created earliest, never touched since, its
      // deadline far outside the proximity window.
      const targetId = await createLoop({
        title: "Sign and return venue contract CT-9993",
        deadline: { type: "by", date: "2026-07-30" },
      });
      // Nine fresher loops with deadlines at the seed datum's date — all
      // deadline-proximity candidates, none sharing people/thread/docs.
      for (let i = 0; i < 9; i += 1) {
        nowMs += 60_000;
        await createLoop({
          title: `Errand number ${i} for the week`,
          deadline: { type: "on_day", date: "2026-07-01" },
        });
      }

      const seededTools = buildTools({
        seedDocIds: [seedDocId],
        reconcileDeadlineWindowMs: 3 * 86_400_000,
      });
      const result = structured(
        await findTool(seededTools, "open_loop_search").invoke(
          { query: "CT-9993 contract signed venue" },
          CTX,
        ),
      );
      const loops = result.data.loops as Array<{ id: string; matchedBy?: string[] }>;
      expect(loops[0]!.id).toBe(targetId);
      expect(loops[0]!.matchedBy).toContain("lexical");
      // The weak deadline-only candidates still fill the remaining slots.
      expect(loops.length).toBe(8);
    });

    test("with no seed docs the search regresses to lexical + semantic only", async () => {
      seedPerson("per_maya");
      upsertDocuments(db, [sourceDoc("msg_seed3", "unrelated body text")]);
      const seedDocId = docIdByExternal(db, "msg_seed3")!;
      linkDocPerson(seedDocId, "per_maya");
      await createLoop({ title: "Reply to the venue quote", actors: ["per_maya"] });

      // Default tools carry no seedDocIds → identity is never consulted.
      const result = structured(
        await findTool(tools, "open_loop_search").invoke({ query: "venue" }, CTX),
      );
      const loops = result.data.loops as Array<{ matchedBy?: string[] }>;
      expect(loops).toHaveLength(1);
      // Only lexical/semantic tags — no identity signal was consulted.
      const tags = loops[0]!.matchedBy ?? [];
      expect(tags).toContain("lexical");
      expect(tags.every((t) => t === "lexical" || t === "semantic")).toBe(true);
    });
  });

  describe("open_loop_search consolidation surface (retired[])", () => {
    test("surfaces a matching retired loop with its outcome, cadence, and recurrence count", async () => {
      const loopId = await createLoop({ title: "Renew the parking permit" });
      // Resolving the loop appends a consolidation trace.
      await findTool(tools, "open_loop_update").invoke({ id: loopId, state: "done" }, CTX);

      const result = structured(
        await findTool(tools, "open_loop_search").invoke({ query: "parking permit" }, CTX),
      );
      const retired = result.data.retired as Array<{
        title: string;
        outcome: string;
        retiredAt: string | null;
        cadenceDays: number | null;
        recurrenceCount: number;
      }>;
      expect(retired).toHaveLength(1);
      expect(retired[0]).toMatchObject({
        title: "Renew the parking permit",
        outcome: "done",
        cadenceDays: null,
        recurrenceCount: 1,
      });
      expect(retired[0]!.retiredAt).not.toBeNull();
    });

    test("returns an empty retired[] when nothing with that wording has retired", async () => {
      await createLoop({ title: "An active unresolved commitment" });
      const result = structured(
        await findTool(tools, "open_loop_search").invoke({ query: "unresolved commitment" }, CTX),
      );
      expect(result.data.retired).toEqual([]);
    });
  });

  test("open_loop_fetch returns the full ledger; unknown ids are clean errors", async () => {
    const loopId = await createLoop();
    await findTool(tools, "open_loop_ledger_append").invoke({ id: loopId, note: "n1" }, CTX);
    const fetched = structured(
      await findTool(tools, "open_loop_fetch").invoke({ id: loopId }, CTX),
    );
    expect((fetched.data as { ledger: unknown[] }).ledger).toHaveLength(1);

    const missing = await findTool(tools, "open_loop_fetch").invoke({ id: "loop_nope" }, CTX);
    expect(missing).toMatchObject({ kind: "error", code: "not_found" });
  });

  test("brief_create stamps the run id, validates citations against the store, and starts unread", async () => {
    upsertDocuments(db, [sourceDoc("msg_1", "the quote")]);
    const known = docIdByExternal(db, "msg_1")!;
    const result = await findTool(tools, "brief_create").invoke(
      {
        kind: "info",
        title: "A quote arrived",
        citations: [known, "doc_deleted"],
        confidence: 0.7,
        urgency: 0.3,
        eventAt: "2026-07-02T18:00:00.000Z",
      },
      CTX,
    );
    const { data } = structured(result);
    const brief = data.brief as { id: string; citations: string[]; state: string };
    expect(brief.state).toBe("unread");
    expect(brief.citations).toEqual([known]);
    expect(data.droppedCitationIds).toEqual(["doc_deleted"]);
    expect(getBrief(db, brief.id)!.createdByRun).toBe("run_test_1");
    expect(getBrief(db, brief.id)!.eventAt).toBe(Date.parse("2026-07-02T18:00:00.000Z"));
  });

  test("brief_create refuses a sibling card on a shared loop and returns candidates", async () => {
    const loopId = await createLoop();
    const first = structured(
      await findTool(tools, "brief_create").invoke(
        {
          kind: "loop",
          title: "Sign the studio hire quote",
          confidence: 0.8,
          urgency: 0.5,
          relatedLoopIds: [loopId],
        },
        CTX,
      ),
    );
    const firstId = (first.data.brief as { id: string }).id;

    const second = structured(
      await findTool(tools, "brief_create").invoke(
        {
          kind: "loop",
          title: "Studio hire quote still needs signing",
          confidence: 0.8,
          urgency: 0.6,
          relatedLoopIds: [loopId],
        },
        CTX,
      ),
    );
    expect(second.resultType).toBe("brief.loop_conflict_candidates");
    const candidates = second.data.candidates as Array<{ id: string; sharedLoopIds: string[] }>;
    expect(candidates.map((c) => c.id)).toEqual([firstId]);
    expect(candidates[0]!.sharedLoopIds).toEqual([loopId]);
    // Nothing was created.
    const listed = structured(await findTool(tools, "brief_list").invoke({}, CTX));
    expect((listed.data.briefs as Array<{ id: string }>).map((b) => b.id)).toEqual([firstId]);
  });

  test("brief_create with supersedes replaces the old card: created + old one leaves the feed", async () => {
    const loopId = await createLoop();
    const first = structured(
      await findTool(tools, "brief_create").invoke(
        {
          kind: "loop",
          title: "Sign the studio hire quote",
          confidence: 0.8,
          urgency: 0.5,
          relatedLoopIds: [loopId],
        },
        CTX,
      ),
    );
    const firstId = (first.data.brief as { id: string }).id;

    const second = structured(
      await findTool(tools, "brief_create").invoke(
        {
          kind: "loop",
          title: "Studio quote — still unsigned, now urgent",
          confidence: 0.85,
          urgency: 0.8,
          relatedLoopIds: [loopId],
          supersedes: [firstId],
        },
        CTX,
      ),
    );
    expect(second.resultType).toBe("brief.created");
    expect(second.data.supersededBriefIds).toEqual([firstId]);
    const newId = (second.data.brief as { id: string }).id;

    // History preserved: the superseded row still exists, state untouched,
    // but its relevance is expired so it is out of the user's feed.
    const old = getBrief(db, firstId)!;
    expect(old.state).toBe("unread");
    expect(old.relevantUntil).not.toBeNull();

    // The guard now sees only the NEW card as active on that loop: a third
    // sibling create conflicts with the replacement, not the retired card.
    const third = structured(
      await findTool(tools, "brief_create").invoke(
        {
          kind: "loop",
          title: "Yet another card for the same quote",
          confidence: 0.5,
          urgency: 0.5,
          relatedLoopIds: [loopId],
        },
        CTX,
      ),
    );
    expect(third.resultType).toBe("brief.loop_conflict_candidates");
    expect((third.data.candidates as Array<{ id: string }>).map((c) => c.id)).toEqual([newId]);
  });

  test("a snoozed card conflicts and is supersedable — it must not wake up beside a replacement", async () => {
    const loopId = await createLoop();
    const first = structured(
      await findTool(tools, "brief_create").invoke(
        {
          kind: "loop",
          title: "Original card",
          confidence: 0.8,
          urgency: 0.5,
          relatedLoopIds: [loopId],
        },
        CTX,
      ),
    );
    const firstId = (first.data.brief as { id: string }).id;
    db.prepare("UPDATE briefs SET state = 'dismissed_snoozed', next_show = ? WHERE id = ?").run(
      nowMs + 3600_000,
      firstId,
    );

    // Still a conflict while parked…
    const refused = structured(
      await findTool(tools, "brief_create").invoke(
        {
          kind: "loop",
          title: "Sibling while snoozed",
          confidence: 0.8,
          urgency: 0.5,
          relatedLoopIds: [loopId],
        },
        CTX,
      ),
    );
    expect(refused.resultType).toBe("brief.loop_conflict_candidates");

    // …and supersedable: the replacement retires it so it cannot resurface.
    const replaced = structured(
      await findTool(tools, "brief_create").invoke(
        {
          kind: "loop",
          title: "Replacement card",
          confidence: 0.85,
          urgency: 0.6,
          relatedLoopIds: [loopId],
          supersedes: [firstId],
        },
        CTX,
      ),
    );
    expect(replaced.resultType).toBe("brief.created");
    expect(replaced.data.supersededBriefIds).toEqual([firstId]);
    expect(getBrief(db, firstId)!.relevantUntil).not.toBeNull();
  });

  test("brief_update on a retired (relevance-expired) card warns; setting relevantUntil does not", async () => {
    const loopId = await createLoop();
    const created = structured(
      await findTool(tools, "brief_create").invoke(
        { kind: "loop", title: "t", confidence: 0.5, urgency: 0.5, relatedLoopIds: [loopId] },
        CTX,
      ),
    );
    const briefId = (created.data.brief as { id: string }).id;
    db.prepare("UPDATE briefs SET relevant_until = ? WHERE id = ?").run(nowMs - 1000, briefId);

    const blind = structured(
      await findTool(tools, "brief_update").invoke({ id: briefId, title: "Edited" }, CTX),
    );
    expect(typeof blind.data.warning).toBe("string");

    const resurfacing = structured(
      await findTool(tools, "brief_update").invoke(
        { id: briefId, relevantUntil: "2027-01-01T00:00:00.000Z" },
        CTX,
      ),
    );
    expect(resurfacing.data.warning).toBeUndefined();
  });

  test("brief_create force:true coexists on a shared loop; unknown supersedes ids are reported", async () => {
    const loopId = await createLoop();
    await findTool(tools, "brief_create").invoke(
      {
        kind: "loop",
        title: "Specific card",
        confidence: 0.8,
        urgency: 0.5,
        relatedLoopIds: [loopId],
      },
      CTX,
    );
    const rollup = structured(
      await findTool(tools, "brief_create").invoke(
        {
          kind: "loop",
          title: "Roll-up across several loops",
          confidence: 0.7,
          urgency: 0.4,
          relatedLoopIds: [loopId],
          force: true,
          supersedes: ["brief_ghost"],
        },
        CTX,
      ),
    );
    expect(rollup.resultType).toBe("brief.created");
    expect(rollup.data.droppedSupersedeIds).toEqual(["brief_ghost"]);
    const listed = structured(await findTool(tools, "brief_list").invoke({}, CTX));
    expect((listed.data.briefs as Array<{ id: string }>).length).toBe(2);
  });

  test("brief_update edits content fields; brief_delete withdraws the card, keeping its record", async () => {
    const loopId = await createLoop();
    const created = structured(
      await findTool(tools, "brief_create").invoke(
        { kind: "loop", title: "t", confidence: 0.5, urgency: 0.5, relatedLoopIds: [loopId] },
        CTX,
      ),
    );
    const briefId = (created.data.brief as { id: string }).id;

    const updated = structured(
      await findTool(tools, "brief_update").invoke(
        { id: briefId, title: "Updated title", nextShow: "2026-07-03T08:00:00.000Z" },
        CTX,
      ),
    );
    expect((updated.data.brief as { title: string }).title).toBe("Updated title");
    expect(getBrief(db, briefId)!.nextShow).toBe(Date.parse("2026-07-03T08:00:00.000Z"));

    // brief_delete withdraws the card: it leaves the feed, and the row —
    // with its claims and edges — survives as the record of what was
    // surfaced.
    const deleted = await findTool(tools, "brief_delete").invoke({ id: briefId }, CTX);
    expect(structured(deleted).data.briefId).toBe(briefId);
    const retired = getBrief(db, briefId);
    expect(retired).not.toBeNull();
    expect(retired!.state).toBe("retired");
    expect(listShowableBriefs(db, nowMs).map((b) => b.id)).not.toContain(briefId);
    // Off every active-brief surface too, not just the feed.
    expect(structured(await findTool(tools, "brief_list").invoke({}, CTX)).data.briefs).toEqual([]);
    // Idempotent: a second withdrawal of an already-terminal card succeeds
    // without disturbing it.
    expect(
      structured(await findTool(tools, "brief_delete").invoke({ id: briefId }, CTX)).data.briefId,
    ).toBe(briefId);
    expect(getBrief(db, briefId)!.state).toBe("retired");
    // An unknown id still refuses rather than silently succeeding.
    expect((await findTool(tools, "brief_delete").invoke({ id: "brief_missing" }, CTX)).kind).toBe(
      "error",
    );
  });

  test("brief_list shows unread/read/snoozed briefs with related loop ids and hides terminal ones", async () => {
    const loopId = await createLoop();
    const created = structured(
      await findTool(tools, "brief_create").invoke(
        { kind: "loop", title: "active", confidence: 0.5, urgency: 0.5, relatedLoopIds: [loopId] },
        CTX,
      ),
    );
    const activeId = (created.data.brief as { id: string }).id;
    const terminal = structured(
      await findTool(tools, "brief_create").invoke(
        { kind: "info", title: "terminal", confidence: 0.5, urgency: 0.5 },
        CTX,
      ),
    );
    const terminalId = (terminal.data.brief as { id: string }).id;
    db.prepare("UPDATE briefs SET state = 'dismissed_acknowledged' WHERE id = ?").run(terminalId);

    const listed = structured(await findTool(tools, "brief_list").invoke({}, CTX));
    const briefs = listed.data.briefs as Array<{ id: string; relatedLoopIds: string[] }>;
    expect(briefs.map((b) => b.id)).toEqual([activeId]);
    expect(briefs[0]!.relatedLoopIds).toEqual([loopId]);
  });

  function pendingCompactionRuns(): Array<{ id: string; payload_json: string; attempts: number }> {
    return db
      .prepare<
        [],
        { id: string; payload_json: string; attempts: number }
      >("SELECT id, payload_json, attempts FROM cognition_runs WHERE kind = 'notes_compaction' AND status = 'pending'")
      .all();
  }

  test("notes_append accepts an over-cap append and schedules ONE compaction run", async () => {
    const small = buildTools({ getNotesMaxBytes: () => 64 });
    const append = findTool(small, "notes_append");
    const first = await append.invoke({ text: "user ignores newsletter deadlines" }, CTX);
    expect(structured(first).resultType).toBe("notes.appended");
    expect(structured(first).data.overCap).toBeUndefined();
    expect(readCognitionNotes(db)).toBe("user ignores newsletter deadlines");
    expect(pendingCompactionRuns()).toHaveLength(0);

    // 33 + 1 + 38 = 72 bytes: above the 64-byte soft cap, within the 128-byte
    // ceiling — the append LANDS and a compaction run is scheduled. The
    // payload is byte-stable (no live counts): the run reads the notes at
    // claim time.
    const second = await append.invoke({ text: "another long-ish lesson to overflow it" }, CTX);
    const secondOut = structured(second);
    expect(secondOut.resultType).toBe("notes.appended");
    expect(secondOut.data.overCap).toBe(true);
    expect(secondOut.data.compactionScheduled).toBe(true);
    expect(readCognitionNotes(db)).toBe(
      "user ignores newsletter deadlines\nanother long-ish lesson to overflow it",
    );
    const runs = pendingCompactionRuns();
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.payload_json)).toEqual({ reason: "notes over soft cap" });

    // A further over-cap append leaves the pending compaction row entirely
    // untouched — even one claimed and in flight (claiming bumps attempts
    // but keeps status 'pending'): no fold, no attempt-budget reset.
    claimDueCognitionRuns(db, { now: nowMs, limit: 10 });
    expect(pendingCompactionRuns()[0]!.attempts).toBe(1);
    const third = await append.invoke({ text: "a third lesson" }, CTX);
    expect(structured(third).data.compactionScheduled).toBe(true);
    const after = pendingCompactionRuns();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(runs[0]!.id);
    expect(after[0]!.attempts).toBe(1);
    expect(after[0]!.payload_json).toBe(runs[0]!.payload_json);
  });

  test("notes_append refuses only above the hard ceiling, reporting the overage", async () => {
    const small = buildTools({ getNotesMaxBytes: () => 64 });
    const append = findTool(small, "notes_append");
    await append.invoke({ text: "x".repeat(60) }, CTX);

    // 60 + 1 + 100 = 161 bytes > the 128-byte ceiling (2x the 64-byte cap).
    const refused = await append.invoke({ text: "y".repeat(100) }, CTX);
    expect(refused).toMatchObject({ kind: "error", code: "notes_cap_exceeded" });
    const message = (refused as { message: string }).message;
    expect(message).toContain("161 bytes");
    expect(message).toContain("33 over");
    expect(message).toContain("128-byte hard ceiling");
    // The stored notes are untouched by the refused append, but the refusal
    // still arms compaction — the blob may already need curation.
    expect(readCognitionNotes(db)).toBe("x".repeat(60));
    expect(pendingCompactionRuns()).toHaveLength(1);
  });

  test("notes_edit over-cap outcomes arm the compaction run", async () => {
    const small = buildTools({ getNotesMaxBytes: () => 32 });
    await findTool(small, "notes_rewrite").invoke({ text: "x".repeat(30) }, CTX);
    const edit = findTool(small, "notes_edit");

    // An edit growing the blob past the hard ceiling is refused AND arms
    // compaction.
    const over = await edit.invoke({ oldText: "x".repeat(30), newText: "z".repeat(70) }, CTX);
    expect(over).toMatchObject({ kind: "error", code: "notes_cap_exceeded" });
    expect(pendingCompactionRuns()).toHaveLength(1);
    db.prepare("DELETE FROM cognition_runs WHERE kind = 'notes_compaction'").run();

    // An edit landing between the soft cap and the ceiling applies, reports
    // overCap, and arms compaction.
    const grown = await edit.invoke({ oldText: "x".repeat(30), newText: "y".repeat(40) }, CTX);
    const out = structured(grown);
    expect(out.data.overCap).toBe(true);
    expect(out.data.compactionScheduled).toBe(true);
    expect(pendingCompactionRuns()).toHaveLength(1);
  });

  test("an over-cap write from the compaction run itself never re-arms compaction", async () => {
    // The executing run IS a notes_compaction run (its row already settled,
    // so no pending row can mask the self-guard).
    enqueueCognitionRun(
      db,
      {
        id: "run_compact_self",
        kind: "notes_compaction",
        payload: { reason: "notes over soft cap" },
        dedupeKey: notesCompactionRunDedupeKey(),
      },
      nowMs,
    );
    claimDueCognitionRuns(db, { now: nowMs, limit: 10 });
    completeCognitionRun(db, "run_compact_self", { usage: null, now: nowMs });

    const small = buildTools({ getNotesMaxBytes: () => 32, runId: "run_compact_self" });
    // 40 bytes: over the 32-byte soft cap, within the 64-byte ceiling — the
    // append lands but schedules nothing, and the response does not claim a
    // compaction was scheduled.
    const appended = await findTool(small, "notes_append").invoke({ text: "y".repeat(40) }, CTX);
    const out = structured(appended);
    expect(out.data.overCap).toBe(true);
    expect(out.data.compactionScheduled).toBeUndefined();
    expect(pendingCompactionRuns()).toHaveLength(0);
  });

  test("notes_edit refuses a lone-surrogate needle as malformed", async () => {
    const small = buildTools({ getNotesMaxBytes: () => 64 });
    await findTool(small, "notes_rewrite").invoke({ text: "plan \u{1F389} party" }, CTX);
    const res = await findTool(small, "notes_edit").invoke(
      { oldText: "plan \ud83c", newText: "plan" },
      CTX,
    );
    expect(res).toMatchObject({ kind: "error", code: "notes_edit_malformed" });
    expect(readCognitionNotes(db)).toBe("plan \u{1F389} party");
  });

  test("notes_rewrite replaces content, returns the post-write content, and enforces the cap", async () => {
    const small = buildTools({ getNotesMaxBytes: () => 32 });
    const rewrite = findTool(small, "notes_rewrite");
    const ok = await rewrite.invoke({ text: "compact lesson" }, CTX);
    expect(structured(ok).data.content).toBe("compact lesson");
    expect(readCognitionNotes(db)).toBe("compact lesson");

    const over = await rewrite.invoke({ text: "x".repeat(64) }, CTX);
    expect(over).toMatchObject({ kind: "error", code: "notes_cap_exceeded" });
    // The refusal names the received size, the overage, and the cap.
    expect((over as { message: string }).message).toContain("64 bytes, 32 over the 32-byte cap");
    expect(readCognitionNotes(db)).toBe("compact lesson");
  });

  test("notes_edit replaces one exact span; refusals name not_found and ambiguous", async () => {
    const small = buildTools({ getNotesMaxBytes: () => 64 });
    await findTool(small, "notes_rewrite").invoke({ text: "alpha beta gamma" }, CTX);
    const edit = findTool(small, "notes_edit");

    const missing = await edit.invoke({ oldText: "zeta", newText: "eta" }, CTX);
    expect(missing).toMatchObject({ kind: "error", code: "notes_edit_not_found" });
    expect((missing as { message: string }).message).toContain('"zeta"');
    expect(readCognitionNotes(db)).toBe("alpha beta gamma");

    const edited = await edit.invoke({ oldText: "beta", newText: "delta" }, CTX);
    expect(structured(edited).resultType).toBe("notes.edited");
    expect(readCognitionNotes(db)).toBe("alpha delta gamma");

    await findTool(small, "notes_rewrite").invoke({ text: "twin twin" }, CTX);
    const ambiguous = await edit.invoke({ oldText: "twin", newText: "solo" }, CTX);
    expect(ambiguous).toMatchObject({ kind: "error", code: "notes_edit_ambiguous" });
    expect((ambiguous as { message: string }).message).toContain("2 times");
    expect(readCognitionNotes(db)).toBe("twin twin");

    // An empty newText deletes the span.
    const deleted = await edit.invoke({ oldText: " twin", newText: "" }, CTX);
    expect(structured(deleted).resultType).toBe("notes.edited");
    expect(readCognitionNotes(db)).toBe("twin");
  });

  test("notes_edit enforces the overflow ceiling but always lets a shrink through", async () => {
    const small = buildTools({ getNotesMaxBytes: () => 32 });
    // 50 bytes: above the 32-byte soft cap, within the 64-byte ceiling.
    await findTool(small, "notes_append").invoke({ text: "a".repeat(24) }, CTX);
    await findTool(small, "notes_append").invoke({ text: "b".repeat(25) }, CTX);
    expect(Buffer.byteLength(readCognitionNotes(db), "utf8")).toBe(50);
    const edit = findTool(small, "notes_edit");

    // A growth past the 64-byte ceiling is refused with the overage numbers.
    const over = await edit.invoke({ oldText: "b".repeat(25), newText: "c".repeat(45) }, CTX);
    expect(over).toMatchObject({ kind: "error", code: "notes_cap_exceeded" });
    expect((over as { message: string }).message).toContain("70 bytes, 6 over");
    expect(Buffer.byteLength(readCognitionNotes(db), "utf8")).toBe(50);

    // A shrink of an already-over-cap blob always lands (reported overCap
    // while still above the soft cap).
    const shrunk = await edit.invoke({ oldText: "b".repeat(25), newText: "b".repeat(10) }, CTX);
    const out = structured(shrunk);
    expect(out.data.overCap).toBe(true);
    expect(Buffer.byteLength(readCognitionNotes(db), "utf8")).toBe(35);
  });

  test("the notes byte cap counts UTF-8 bytes, not characters", async () => {
    const small = buildTools({ getNotesMaxBytes: () => 8 });
    // Four 3-byte characters = 12 bytes > 8, though only 4 characters.
    const over = await findTool(small, "notes_rewrite").invoke({ text: "€€€€" }, CTX);
    expect(over).toMatchObject({ kind: "error", code: "notes_cap_exceeded" });
  });

  test("schedule_agent_run enqueues a time_based run at the requested time", async () => {
    const result = await findTool(tools, "schedule_agent_run").invoke(
      { when: "2026-07-04T05:00:00.000Z", prompt: "re-check the venue quote loop" },
      CTX,
    );
    const { data } = structured(result);
    const run = getCognitionRun(db, data.runId as string);
    expect(run).not.toBeNull();
    expect(run!.kind).toBe("time_based");
    // No loopId passed → payload stays exactly as before (behaves as today).
    expect(run!.payload).toEqual({ prompt: "re-check the venue quote loop" });
    expect(run!.nextAttemptAt).toBe(Date.parse("2026-07-04T05:00:00.000Z"));
  });

  test("schedule_agent_run persists a structured loopId when the loop exists", async () => {
    const loopId = await createLoop();
    const result = await findTool(tools, "schedule_agent_run").invoke(
      { when: "2026-07-07T08:00:00.000Z", prompt: "check the reply arrived", loopId },
      CTX,
    );
    const { data } = structured(result);
    expect(data.droppedLoopId).toBeUndefined();
    const run = getCognitionRun(db, data.runId as string);
    expect(run!.payload).toEqual({ prompt: "check the reply arrived", loopId });
  });

  test("schedule_agent_run drops an unknown loopId and reports it", async () => {
    const result = await findTool(tools, "schedule_agent_run").invoke(
      { when: "2026-07-07T08:00:00.000Z", prompt: "check something", loopId: "loop_gone" },
      CTX,
    );
    const { data } = structured(result);
    expect(data.droppedLoopId).toBe("loop_gone");
    const run = getCognitionRun(db, data.runId as string);
    expect(run!.payload).toEqual({ prompt: "check something" });
  });

  // ── a second same-loop, same-day check ─────────────────────────────────
  const MORNING_AT = "2026-07-09T07:00:00.000Z";
  const EVENING_AT = "2026-07-09T18:00:00.000Z";
  const MORNING_PROMPT = "Re-verify the venue quote reply before its brief surfaces";
  const EVENING_PROMPT = "Refresh the venue quote brief before the evening call";

  /** Schedule the morning check for `loopId` and return its run id. */
  async function scheduleMorning(loopId: string): Promise<string> {
    const result = await findTool(tools, "schedule_agent_run").invoke(
      { when: MORNING_AT, prompt: MORNING_PROMPT, loopId },
      CTX,
    );
    return structured(result).data.runId as string;
  }

  function pendingChecksFor(loopId: string) {
    return listCognitionRuns(db, { kinds: ["time_based"], statuses: ["pending"], loopId });
  }

  test("schedule_agent_run refuses a second same-loop, same-day check with a schedule_conflict error naming the pending check's real time and instruction", async () => {
    const loopId = await createLoop();
    const morningRunId = await scheduleMorning(loopId);
    const before = getCognitionRun(db, morningRunId)!;

    const result = await findTool(tools, "schedule_agent_run").invoke(
      { when: EVENING_AT, prompt: EVENING_PROMPT, loopId },
      CTX,
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.code).toBe("schedule_conflict");
    // What already exists: the check's id, the hour it will ACTUALLY fire
    // (07:00, not the 18:00 just asked for) and the instruction it carries.
    expect(result.message).toContain(morningRunId);
    expect(result.message).toContain(MORNING_AT);
    expect(result.message).toContain(`"${MORNING_PROMPT}"`);
    // The two retries, spelled as the exact argument to pass, and the hour a
    // second run would get — so a model that reads a tool error as "stop"
    // still sees that it is being asked to choose.
    expect(result.message).toContain('onConflict: "merge"');
    expect(result.message).toContain(`onConflict: "add"`);
    expect(result.message).toContain(EVENING_AT);
    expect(result.message).toContain("do NOT call again");

    // Nothing was written: the morning check stands exactly as it was, and
    // no run was minted for the evening instruction.
    expect(pendingChecksFor(loopId)).toEqual([before]);
  });

  test("schedule_agent_run with onConflict merge lands on the pending check: one run carrying both instructions, reported at the hour it really fires", async () => {
    const loopId = await createLoop();
    const morningRunId = await scheduleMorning(loopId);

    const result = await findTool(tools, "schedule_agent_run").invoke(
      { when: EVENING_AT, prompt: EVENING_PROMPT, loopId, onConflict: "merge" },
      CTX,
    );
    const { data } = structured(result);
    expect(data.runId).toBe(morningRunId);
    expect(data.merged).toBe(true);
    // Not an echo of the 18:00 requested: the merged instruction runs when
    // the morning check runs.
    expect(data.scheduledFor).toBe(MORNING_AT);

    const pending = pendingChecksFor(loopId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.nextAttemptAt).toBe(Date.parse(MORNING_AT));
    expect(pending[0]!.payload).toEqual({
      prompt: `${MORNING_PROMPT}\n\nAlso requested for ${EVENING_AT}: ${EVENING_PROMPT}`,
      loopId,
    });
  });

  test("schedule_agent_run with onConflict add schedules a second run alongside the pending check", async () => {
    const loopId = await createLoop();
    const morningRunId = await scheduleMorning(loopId);
    const before = getCognitionRun(db, morningRunId)!;

    const result = await findTool(tools, "schedule_agent_run").invoke(
      { when: EVENING_AT, prompt: EVENING_PROMPT, loopId, onConflict: "add" },
      CTX,
    );
    const { data } = structured(result);
    expect(data.runId).not.toBe(morningRunId);
    expect(data.scheduledFor).toBe(EVENING_AT);
    expect(data.merged).toBeUndefined();

    const pending = pendingChecksFor(loopId).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
    expect(pending).toHaveLength(2);
    expect(pending[0]).toEqual(before);
    expect(pending[1]!.payload).toEqual({ prompt: EVENING_PROMPT, loopId });
    expect(pending[1]!.nextAttemptAt).toBe(Date.parse(EVENING_AT));
  });

  test("schedule_agent_run refuses a merge into a check whose instruction is at the cap, leaving add as the retry", async () => {
    const loopId = await createLoop();
    // A full-size check absorbs two further full-size instructions; the third
    // would not fit.
    const big = "z".repeat(SCHEDULED_INSTRUCTION_REQUEST_MAX_CHARS);
    const seeded = await findTool(tools, "schedule_agent_run").invoke(
      { when: MORNING_AT, prompt: big, loopId },
      CTX,
    );
    const morningRunId = structured(seeded).data.runId as string;
    for (const hour of ["09", "12"]) {
      const merged = await findTool(tools, "schedule_agent_run").invoke(
        { when: `2026-07-09T${hour}:00:00.000Z`, prompt: big, loopId, onConflict: "merge" },
        CTX,
      );
      expect(structured(merged).data.runId).toBe(morningRunId);
    }
    const before = getCognitionRun(db, morningRunId)!;
    expect((before.payload as { prompt: string }).prompt.length).toBeLessThanOrEqual(
      SCHEDULED_INSTRUCTION_MAX_CHARS,
    );

    const result = await findTool(tools, "schedule_agent_run").invoke(
      { when: EVENING_AT, prompt: big, loopId, onConflict: "merge" },
      CTX,
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.code).toBe("schedule_conflict");
    expect(result.message).toContain(`${SCHEDULED_INSTRUCTION_MAX_CHARS}-character cap`);
    expect(result.message).toContain(MORNING_AT);
    expect(result.message).toContain('onConflict: "add"');
    expect(result.message).not.toContain('onConflict: "merge"');
    expect(getCognitionRun(db, morningRunId)).toEqual(before);

    const added = await findTool(tools, "schedule_agent_run").invoke(
      { when: EVENING_AT, prompt: big, loopId, onConflict: "add" },
      CTX,
    );
    expect(structured(added).data.scheduledFor).toBe(EVENING_AT);
    expect(pendingChecksFor(loopId)).toHaveLength(2);
  });

  test("schedule_agent_run rejects an onConflict value outside merge/add as invalid_args", async () => {
    const loopId = await createLoop();
    const result = await findTool(tools, "schedule_agent_run").invoke(
      { when: EVENING_AT, prompt: EVENING_PROMPT, loopId, onConflict: "skip" },
      CTX,
    );
    expect(result).toMatchObject({ kind: "error", code: "invalid_args" });
    expect(pendingChecksFor(loopId)).toHaveLength(0);
  });

  /** Schedule a loop-linked check and return its run id. */
  async function scheduleForLoop(
    loopId: string,
    when = "2026-07-09T08:00:00.000Z",
  ): Promise<string> {
    const result = await findTool(tools, "schedule_agent_run").invoke(
      { when, prompt: `re-check ${loopId}`, loopId },
      CTX,
    );
    return structured(result).data.runId as string;
  }

  test("resolving a loop cancels its pending loopId-linked scheduled runs", async () => {
    const loopId = await createLoop();
    const runId = await scheduleForLoop(loopId);
    expect(getCognitionRun(db, runId)).not.toBeNull();

    await findTool(tools, "open_loop_update").invoke({ id: loopId, state: "done" }, CTX);
    expect(getCognitionRun(db, runId)).toBeNull();
  });

  test("dismissing a loop also cancels its checks; snoozing does not", async () => {
    const dismissed = await createLoop();
    const dismissedRun = await scheduleForLoop(dismissed);
    await findTool(tools, "open_loop_update").invoke({ id: dismissed, state: "dismissed" }, CTX);
    expect(getCognitionRun(db, dismissedRun)).toBeNull();

    const snoozed = await createLoop();
    const snoozedRun = await scheduleForLoop(snoozed);
    await findTool(tools, "open_loop_update").invoke({ id: snoozed, state: "snoozed" }, CTX);
    // A snooze is "revisit later" — its scheduled check must survive.
    expect(getCognitionRun(db, snoozedRun)).not.toBeNull();
  });

  test("resolving a loop leaves other loops' and loop-less checks untouched", async () => {
    const loopA = await createLoop();
    const loopB = await createLoop();
    const runA = await scheduleForLoop(loopA);
    const runB = await scheduleForLoop(loopB);
    // A loop-less check (no loopId) never participates in the cascade.
    const looselessResult = await findTool(tools, "schedule_agent_run").invoke(
      { when: "2026-07-09T08:00:00.000Z", prompt: "pre-event refresh" },
      CTX,
    );
    const looseRun = structured(looselessResult).data.runId as string;

    await findTool(tools, "open_loop_update").invoke({ id: loopA, state: "done" }, CTX);
    expect(getCognitionRun(db, runA)).toBeNull();
    expect(getCognitionRun(db, runB)).not.toBeNull();
    expect(getCognitionRun(db, looseRun)).not.toBeNull();
  });

  test("deleting a loop cancels its pending loopId-linked scheduled runs", async () => {
    const loopId = await createLoop();
    const runId = await scheduleForLoop(loopId);
    await findTool(tools, "open_loop_delete").invoke({ id: loopId }, CTX);
    expect(getCognitionRun(db, runId)).toBeNull();
  });

  test("the cascade spares claimed/in-flight and completed runs, and is idempotent", async () => {
    const claimedLoop = await createLoop();
    const claimedRun = await scheduleForLoop(claimedLoop, "2026-07-02T09:00:00.000Z");
    // Claim it → in-flight (stays `pending` on disk with attempts bumped).
    claimDueCognitionRuns(db, { now: Date.parse("2026-07-02T09:30:00.000Z"), limit: 10 });
    await findTool(tools, "open_loop_update").invoke({ id: claimedLoop, state: "done" }, CTX);
    expect(getCognitionRun(db, claimedRun)).not.toBeNull();

    const doneLoop = await createLoop();
    const doneRun = await scheduleForLoop(doneLoop, "2026-07-02T09:00:00.000Z");
    claimDueCognitionRuns(db, { now: Date.parse("2026-07-02T09:30:00.000Z"), limit: 10 });
    completeCognitionRun(db, doneRun, { usage: null, now: Date.parse("2026-07-02T09:31:00.000Z") });
    await findTool(tools, "open_loop_update").invoke({ id: doneLoop, state: "done" }, CTX);
    expect(getCognitionRun(db, doneRun)).not.toBeNull();

    // Idempotent: resolving an already-resolved loop again is a clean no-op.
    const before = listCognitionRuns(db).length;
    await findTool(tools, "open_loop_update").invoke({ id: claimedLoop, state: "done" }, CTX);
    expect(listCognitionRuns(db).length).toBe(before);
  });

  // ── (1b) engine auto-attaches loopId to a follow-up check ────────────
  /** Schedule with NO explicit loopId; return the enqueued run's payload. */
  async function scheduleNoLoopId(
    toolset: ToolHandle[] = tools,
    prompt = "follow up later",
  ): Promise<Record<string, unknown>> {
    const result = await findTool(toolset, "schedule_agent_run").invoke(
      { when: "2026-07-09T08:00:00.000Z", prompt },
      CTX,
    );
    const run = getCognitionRun(db, structured(result).data.runId as string);
    return run!.payload as Record<string, unknown>;
  }

  test("schedule_agent_run auto-attaches the loopId when the run touched exactly one loop", async () => {
    const loopId = await createLoop();
    const payload = await scheduleNoLoopId();
    // The run created exactly one loop → its follow-up check is linked to it.
    expect(payload).toEqual({ prompt: "follow up later", loopId });
  });

  test("schedule_agent_run leaves the check loop-less when zero loops were touched", async () => {
    // Fresh run, nothing created/updated, no triggering loop → ambiguous(0).
    const payload = await scheduleNoLoopId();
    expect(payload).toEqual({ prompt: "follow up later" });
  });

  test("schedule_agent_run leaves the check loop-less when several loops were touched", async () => {
    await createLoop();
    await createLoop();
    // Two loops created this run → ambiguous(>1) → no auto-attach.
    const payload = await scheduleNoLoopId();
    expect(payload).toEqual({ prompt: "follow up later" });
  });

  test("schedule_agent_run auto-attaches the triggering loop of a loop-scoped run", async () => {
    // The loop exists in the store but was NOT created by this toolset build;
    // the run is scoped to it (a loop-scoped check re-scheduling itself).
    const loopId = await createLoop();
    const scoped = buildTools({ triggeringLoopId: loopId });
    const payload = await scheduleNoLoopId(scoped);
    expect(payload).toEqual({ prompt: "follow up later", loopId });
  });

  test("schedule_agent_run does not auto-attach a triggering loop that no longer exists", async () => {
    const scoped = buildTools({ triggeringLoopId: "loop_gone" });
    const payload = await scheduleNoLoopId(scoped);
    // A stale/deleted triggering loop is store-validated away → loop-less.
    expect(payload).toEqual({ prompt: "follow up later" });
  });

  test("schedule_agent_run: an explicit loopId still wins over the auto-scope", async () => {
    const autoLoop = await createLoop();
    const explicitLoop = await createLoop();
    // Two loops touched → auto-scope is ambiguous, but the explicit id is honoured.
    const result = await findTool(tools, "schedule_agent_run").invoke(
      { when: "2026-07-09T08:00:00.000Z", prompt: "p", loopId: explicitLoop },
      CTX,
    );
    const run = getCognitionRun(db, structured(result).data.runId as string);
    expect(run!.payload).toEqual({ prompt: "p", loopId: explicitLoop });
    expect(autoLoop).not.toBe(explicitLoop);
  });

  // ── (2) resolving a loop clears its still-actionable briefs ──────────
  /** Create a loop-linked brief; return its id. */
  async function createBriefForLoop(loopId: string, title = "actionable"): Promise<string> {
    // force: fixtures legitimately stack several briefs on one loop to
    // exercise retract/delete cascades; the one-card-per-loop guard is
    // covered by its own tests above.
    const result = await findTool(tools, "brief_create").invoke(
      { kind: "loop", title, confidence: 0.6, urgency: 0.6, relatedLoopIds: [loopId], force: true },
      CTX,
    );
    return (structured(result).data.brief as { id: string }).id;
  }

  test("resolving a loop (done) retracts its non-terminal briefs to a terminal handled state", async () => {
    const loopId = await createLoop();
    const briefId = await createBriefForLoop(loopId);
    expect(getBrief(db, briefId)!.state).toBe("unread");

    await findTool(tools, "open_loop_update").invoke({ id: loopId, state: "done" }, CTX);
    expect(getBrief(db, briefId)!.state).toBe("dismissed_already_handled");
  });

  test("dismissing a loop also retracts its briefs; a read brief is cleared too", async () => {
    const loopId = await createLoop();
    const briefId = await createBriefForLoop(loopId);
    // Move it to `read` (still non-terminal / still actionable on the feed).
    db.prepare("UPDATE briefs SET state = 'read' WHERE id = ?").run(briefId);
    expect(getBrief(db, briefId)!.state).toBe("read");

    await findTool(tools, "open_loop_update").invoke({ id: loopId, state: "dismissed" }, CTX);
    expect(getBrief(db, briefId)!.state).toBe("dismissed_already_handled");
  });

  test("the brief retraction leaves an unrelated loop's brief untouched and is idempotent", async () => {
    const loopId = await createLoop();
    const otherLoop = await createLoop();
    const briefId = await createBriefForLoop(loopId);
    const otherBriefId = await createBriefForLoop(otherLoop, "other");

    await findTool(tools, "open_loop_update").invoke({ id: loopId, state: "done" }, CTX);
    expect(getBrief(db, briefId)!.state).toBe("dismissed_already_handled");
    // The other loop's brief is untouched.
    expect(getBrief(db, otherBriefId)!.state).toBe("unread");

    // Idempotent: resolving the already-resolved loop again is a clean no-op.
    await findTool(tools, "open_loop_update").invoke({ id: loopId, state: "done" }, CTX);
    expect(getBrief(db, briefId)!.state).toBe("dismissed_already_handled");
  });

  test("a snooze does not retract briefs; a terminal brief is left as-is on resolve", async () => {
    const loopId = await createLoop();
    const activeBrief = await createBriefForLoop(loopId);
    const terminalBrief = await createBriefForLoop(loopId, "already handled");
    db.prepare("UPDATE briefs SET state = 'dismissed_acknowledged' WHERE id = ?").run(
      terminalBrief,
    );

    // A snooze is "revisit later" — briefs must NOT be retracted.
    await findTool(tools, "open_loop_update").invoke({ id: loopId, state: "snoozed" }, CTX);
    expect(getBrief(db, activeBrief)!.state).toBe("unread");

    // Now resolve: the active brief is retracted; the terminal one is untouched.
    await findTool(tools, "open_loop_update").invoke({ id: loopId, state: "done" }, CTX);
    expect(getBrief(db, activeBrief)!.state).toBe("dismissed_already_handled");
    expect(getBrief(db, terminalBrief)!.state).toBe("dismissed_acknowledged");
  });

  test("deleting a loop clears its non-terminal briefs (deletion invariant)", async () => {
    const loopId = await createLoop();
    const briefId = await createBriefForLoop(loopId);
    const result = await findTool(tools, "open_loop_delete").invoke({ id: loopId }, CTX);
    // The deletion invariant removes the attached non-terminal brief outright.
    expect(structured(result).data.deletedBriefIds as string[]).toContain(briefId);
    expect(getBrief(db, briefId)).toBeNull();
  });

  test("zod-at-boundary: malformed arguments never reach the store", async () => {
    const cases: Array<[string, unknown]> = [
      ["open_loop_create", { title: "", confidence: 0.5, importance: 0.5 }],
      ["open_loop_create", { title: "t", confidence: 1.5, importance: 0.5 }],
      ["open_loop_update", { id: "x", state: "resolved" }],
      ["brief_create", { kind: "alert", title: "t", confidence: 0.5, urgency: 0.5 }],
      [
        "brief_create",
        { kind: "info", title: "t", confidence: 0.5, urgency: 0.5, eventAt: "soonish" },
      ],
      ["schedule_agent_run", { when: "not-a-date", prompt: "p" }],
      ["notes_append", { text: "" }],
      ["notes_edit", { oldText: "", newText: "x" }],
      ["notes_edit", { newText: "x" }],
      ["open_loop_ledger_append", { id: "x" }],
      ["temporal_annotation_update", { annotationId: "ta_x" }],
      ["temporal_annotation_update", { annotationId: "ta_x", until: "2026-09-21" }],
    ];
    for (const [name, args] of cases) {
      const result = await findTool(tools, name).invoke(args, CTX);
      expect(result, `${name} should reject ${JSON.stringify(args)}`).toMatchObject({
        kind: "error",
        code: "invalid_args",
      });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM open_loops").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefs").get()).toEqual({ n: 0 });
  });

  test("mutations against missing ids are clean not_found errors", async () => {
    for (const [name, args] of [
      ["open_loop_update", { id: "loop_gone", state: "done" }],
      ["open_loop_ledger_append", { id: "loop_gone", note: "n" }],
      ["open_loop_delete", { id: "loop_gone" }],
      ["brief_update", { id: "brief_gone", title: "t" }],
      ["brief_delete", { id: "brief_gone" }],
      ["brief_fetch", { id: "brief_gone" }],
    ] as Array<[string, unknown]>) {
      const result = await findTool(tools, name).invoke(args, CTX);
      expect(result, name).toMatchObject({ kind: "error", code: "not_found" });
    }
  });

  test("temporal_annotation_add refuses with overlap candidates, then honours force", async () => {
    const first = await findTool(tools, "temporal_annotation_add").invoke(
      { when: "2026-08-14", sentence: "Ferry to the island departs", kind: "event" },
      CTX,
    );
    expect(structured(first).resultType).toBe("temporal_annotation.added");
    const firstId = structured(first).data.id as string;

    // Same day again (an instant this time — the probe widens to the whole
    // UTC day): refused, with the existing entry surfaced as a candidate.
    const clash = await findTool(tools, "temporal_annotation_add").invoke(
      { when: "2026-08-14T09:00:00.000Z", sentence: "Boat leaves the harbour", kind: "event" },
      CTX,
    );
    const clashOut = structured(clash);
    expect(clashOut.resultType).toBe("temporal_annotation.overlap_candidates");
    const candidates = clashOut.data.candidates as Array<{ id: string; sentence: string }>;
    expect(candidates.map((c) => c.id)).toContain(firstId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM temporal_annotations").get()).toEqual({ n: 1 });

    // A genuinely distinct same-day event proceeds with force:true.
    const forced = await findTool(tools, "temporal_annotation_add").invoke(
      {
        when: "2026-08-14T09:00:00.000Z",
        sentence: "Dentist check-up",
        kind: "appointment",
        force: true,
      },
      CTX,
    );
    expect(structured(forced).resultType).toBe("temporal_annotation.added");
    expect(db.prepare("SELECT COUNT(*) AS n FROM temporal_annotations").get()).toEqual({ n: 2 });

    // A non-overlapping time needs no force at all.
    const clear = await findTool(tools, "temporal_annotation_add").invoke(
      { when: "2026-09-01", sentence: "Lease renewal window opens", kind: "deadline" },
      CTX,
    );
    expect(structured(clear).resultType).toBe("temporal_annotation.added");
  });

  test("temporal_annotation_add accepts every kind in the shared vocabulary", async () => {
    for (const [i, kind] of TEMPORAL_KINDS.entries()) {
      // One distinct day per kind, so the overlap probe never intervenes.
      const day = String(i + 1).padStart(2, "0");
      const added = await findTool(tools, "temporal_annotation_add").invoke(
        { when: `2027-03-${day}`, sentence: `A ${kind} worth remembering`, kind },
        CTX,
      );
      expect(structured(added).resultType, kind).toBe("temporal_annotation.added");
      expect(
        db
          .prepare("SELECT kind FROM temporal_annotations WHERE id = ?")
          .pluck()
          .get(structured(added).data.id as string),
      ).toBe(kind);
    }

    const outsideVocabulary = await findTool(tools, "temporal_annotation_add").invoke(
      { when: "2027-04-01", sentence: "Named after its producer, not its nature", kind: "gmail" },
      CTX,
    );
    expect(outsideVocabulary).toMatchObject({ kind: "error", code: "invalid_args" });
  });

  test("reconciles against immutable projections and persists only verified projection links", async () => {
    const projectionId = "tp_calendar_example";
    const projectionStart = Date.parse("2026-08-14T09:00:00.000Z");
    const projectionEnd = Date.parse("2026-08-14T10:00:00.000Z");
    const temporalPort: TemporalReadPort = {
      query(input) {
        const from = Date.parse(input.from);
        const to = Date.parse(input.to ?? input.from);
        const includeId = input.entityIds === undefined || input.entityIds.includes(projectionId);
        const include = includeId && from < projectionEnd && to > projectionStart;
        return Promise.resolve({
          type: "temporal.results",
          window: {
            start: "2026-08-14T00:00:00.000Z",
            endExclusive: "2026-08-15T00:00:00.000Z",
            timeZone: input.timeZone,
          },
          items: include
            ? [
                {
                  id: projectionId,
                  origin: "projection",
                  start: "2026-08-14T09:00:00.000Z",
                  endExclusive: "2026-08-14T10:00:00.000Z",
                  precision: "instant",
                  allDay: false,
                  timeZone: "UTC",
                  label: "Studio planning session",
                  kind: "appointment",
                  modality: "scheduled",
                  status: "active",
                  projection: {
                    sourceId: "calendar:example",
                    slot: "calendar",
                    projectedAt: "2026-08-01T00:00:00.000Z",
                    revision: "revision-example",
                  },
                },
              ]
            : [],
          coverage: {
            projectionSources: [],
            specialistSources: [],
            annotations: { selective: true },
          },
          truncated: false,
        });
      },
    };
    const projectionAwareTools = buildTools({ temporalPort });

    const refused = structured(
      await findTool(projectionAwareTools, "temporal_annotation_add").invoke(
        {
          when: "2026-08-14T09:00:00.000Z",
          sentence: "Studio planning session",
          kind: "event",
        },
        CTX,
      ),
    );
    expect(refused.resultType).toBe("temporal_annotation.overlap_candidates");
    expect(refused.data.candidates).toEqual([
      expect.objectContaining({
        id: projectionId,
        origin: "projection",
        label: "Studio planning session",
      }),
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM temporal_annotations").get()).toEqual({ n: 0 });

    const linked = structured(
      await findTool(projectionAwareTools, "temporal_annotation_add").invoke(
        {
          when: "2026-08-14T09:00:00.000Z",
          sentence: "This session resolves the launch dependency",
          kind: "event",
          projectionIds: [projectionId],
          force: true,
        },
        CTX,
      ),
    );
    expect(linked.resultType).toBe("temporal_annotation.added");
    const annotationId = linked.data.id as string;
    expect(
      db
        .prepare(
          "SELECT projection_id FROM temporal_annotation_projections WHERE annotation_id = ?",
        )
        .pluck()
        .all(annotationId),
    ).toEqual([projectionId]);

    const moved = await findTool(projectionAwareTools, "temporal_annotation_update").invoke(
      {
        annotationId,
        when: "2026-08-16T09:00:00.000Z",
      },
      CTX,
    );
    expect(moved).toMatchObject({
      kind: "error",
      code: "invalid_args",
      message: expect.stringContaining("non-overlapping"),
    });
    expect(
      db
        .prepare<
          [string],
          { canonical: string }
        >("SELECT canonical FROM temporal_annotations WHERE id = ?")
        .get(annotationId),
    ).toEqual({ canonical: "2026-08-14T09:00:00.000Z" });

    const unknown = await findTool(projectionAwareTools, "temporal_annotation_add").invoke(
      {
        when: "2026-08-14T09:00:00.000Z",
        sentence: "Invented interpretation",
        projectionIds: ["tp_unknown"],
        force: true,
      },
      CTX,
    );
    expect(unknown).toMatchObject({ kind: "error", code: "invalid_args" });
  });

  test("projection links fail closed when the temporal read port is unavailable", async () => {
    const result = await findTool(tools, "temporal_annotation_add").invoke(
      {
        when: "2026-08-14T09:00:00.000Z",
        sentence: "This session resolves the launch dependency",
        kind: "event",
        projectionIds: ["tp_unverified"],
        force: true,
      },
      CTX,
    );

    expect(result).toMatchObject({
      kind: "error",
      code: "invalid_args",
      message: expect.stringContaining("cannot be verified"),
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM temporal_annotations").get()).toEqual({ n: 0 });
  });

  test("the add-reconcile probe ignores coarse entries and leads with the tightest candidate", async () => {
    // A year-scale fact must not blanket-refuse concrete adds inside it.
    const year = await findTool(tools, "temporal_annotation_add").invoke(
      { when: "2026", sentence: "Travel document valid through the year", kind: "expiry" },
      CTX,
    );
    expect(structured(year).resultType).toBe("temporal_annotation.added");
    const clearOfYear = await findTool(tools, "temporal_annotation_add").invoke(
      { when: "2026-08-20", sentence: "Team offsite dinner", kind: "event" },
      CTX,
    );
    expect(structured(clearOfYear).resultType).toBe("temporal_annotation.added");

    // A wide-but-capped range and a tight same-day entry both overlap the
    // probe; the tight one (the plausible restatement) leads the candidates.
    const range = await findTool(tools, "temporal_annotation_add").invoke(
      {
        when: "2026-09-01",
        until: "2026-09-21",
        sentence: "House renovation works window",
        kind: "event",
        force: true,
      },
      CTX,
    );
    expect(structured(range).resultType).toBe("temporal_annotation.added");
    const refused = await findTool(tools, "temporal_annotation_add").invoke(
      { when: "2026-08-20", sentence: "Offsite dinner at the harbour", kind: "event" },
      CTX,
    );
    const out = structured(refused);
    expect(out.resultType).toBe("temporal_annotation.overlap_candidates");
    const cands = out.data.candidates as Array<{ sentence: string }>;
    expect(cands[0]!.sentence).toBe("Team offsite dinner");
    expect(cands.map((c) => c.sentence)).not.toContain("Travel document valid through the year");
  });

  test("every mutating tool declares itself, and the set matches the contract list", () => {
    // Build with the optional annotate_durable tool enabled so the FULL
    // mutating set is present (it is absent from the toolset unless annotations
    // are on) — the contract list must still enumerate it for the sub-agent split.
    const full = buildTools({ annotationsEnabled: true });
    const declared = new Set(full.filter((t) => t.mutates === true).map((t) => t.name));
    // `merge_adjudicate` is built by the runtime for a merge-adjudication run
    // rather than here, but it writes durable state and is listed so the
    // per-workflow authority filter covers it.
    expect(declared.add("merge_adjudicate")).toEqual(new Set(COGNITION_MUTATING_TOOL_NAMES));
    // Read tools stay undeclared.
    for (const name of ["open_loop_search", "open_loop_fetch", "brief_list", "brief_fetch"]) {
      expect(findTool(tools, name).mutates).not.toBe(true);
    }
  });
});
