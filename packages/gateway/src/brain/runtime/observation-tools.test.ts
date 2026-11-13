// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The observation tools (`observation_note`, `observation_withdraw`,
 * `observation_list`) over a real SQLite store and the direct write gate:
 * argument validation, the evidence firewall (readable, original, verbatim
 * quotes), self-authorship, scoring at note time, supersession and the
 * listing window.
 */

import { existsSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createOpenLoop } from "../storage/open-loops.js";
import {
  createObservation,
  getObservation,
  transitionObservation,
} from "../storage/observations.js";
import { createOpenLoopMirror } from "./mirror.js";
import {
  buildCognitionOwnTools,
  COGNITION_MUTATING_TOOL_NAMES,
  type CognitionToolDeps,
} from "./tools.js";
import type { ObservationScoringInput } from "../observations/noting.js";
import type { SearchPort, ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test").child("observation-tools");
const CTX = { sessionId: "S", messageId: "M" };
const DAY = 86_400_000;

function doc(
  externalId: string,
  content: string,
  documentType = "email",
  sourceId = "gmail-test",
): DocumentInput {
  return {
    providerId: ProviderId("google"),
    sourceId: SourceId(sourceId),
    externalId,
    title: `Message ${externalId}`,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    sourceCreatedAt: "2026-07-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
    metadata: { documentType },
  };
}

const emptySearch: SearchPort = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async search(input) {
    return { query: input.query, durationMs: 0, results: [] };
  },
};

function structured(result: ToolResult): { resultType: string; data: Record<string, unknown> } {
  if (result.kind !== "structured")
    throw new Error(`expected a structured result, got ${JSON.stringify(result)}`);
  return { resultType: result.resultType, data: result.data as Record<string, unknown> };
}

function errorCode(result: ToolResult): string {
  if (result.kind !== "error") throw new Error(`expected an error, got ${JSON.stringify(result)}`);
  return result.code;
}

describe("observation tools", () => {
  let path: string;
  let db: Db;
  let nowMs: number;
  let seq: number;
  let tools: ToolHandle[];

  function build(overrides: Partial<CognitionToolDeps> = {}): ToolHandle[] {
    const writeGate = directWriteGate(db);
    return buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearch,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => nowMs,
      runId: "run_obs_1",
      idGen: () => `id${++seq}`,
      log,
      ...overrides,
    });
  }

  function tool(name: string): ToolHandle {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }

  function note(args: Record<string, unknown>): Promise<ToolResult> {
    return tool("observation_note").invoke({ annotationDependencies: [], ...args }, CTX);
  }

  function docId(externalId: string): string {
    return db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId)!.id;
  }

  function markAuthor(documentId: string, personId: string, role = "author"): void {
    db.prepare(
      "INSERT INTO document_people (document_id, person_id, role, source_id) VALUES (?, ?, ?, 'test')",
    ).run(documentId, personId, role);
  }

  function addPerson(id: string, isSelf: boolean): void {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, 'contacts', ?, '2020-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(id, isSelf ? "Me" : "Maya Reeves", isSelf ? 1 : 0);
  }

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    nowMs = Date.parse("2026-07-02T10:00:00.000Z");
    seq = 0;
    upsertDocuments(db, [
      doc("lease", "The studio lease renewal form is due back by Friday 10 July."),
      doc("dentist", "Your dental check-up is confirmed for Tuesday at 9am."),
      doc("synth", "A generated synthesis about the lease.", "knowledge"),
    ]);
    tools = build();
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test("both writing observation tools are in the mutating set; listing is not", () => {
    expect(COGNITION_MUTATING_TOOL_NAMES.has("observation_note")).toBe(true);
    expect(COGNITION_MUTATING_TOOL_NAMES.has("observation_withdraw")).toBe(true);
    expect(COGNITION_MUTATING_TOOL_NAMES.has("observation_list")).toBe(false);
    expect(tool("observation_note").mutates).toBe(true);
    expect(tool("observation_withdraw").mutates).toBe(true);
  });

  describe("observation_note", () => {
    test.each([
      ["no citations", { summary: "Lease form due", citations: [] }],
      [
        "a claim quote shorter than 12 characters",
        { summary: "Lease form due", citations: ["X"], claims: [{ docId: "X", quote: "short" }] },
      ],
      ["an unknown key", { summary: "Lease form due", citations: ["X"], extra: true }],
      ["an empty summary", { summary: "", citations: ["X"] }],
      [
        "a non-ISO relevantUntil",
        { summary: "Lease form due", citations: ["X"], relevantUntil: "next friday" },
      ],
    ])("rejects %s as invalid_args", async (_label, args) => {
      expect(errorCode(await note(args))).toBe("invalid_args");
      expect(db.prepare("SELECT COUNT(*) AS n FROM observations").get()).toEqual({ n: 0 });
    });

    test("refuses a relevance window that has already ended", async () => {
      const result = await note({
        summary: "Lease form due",
        citations: [docId("lease")],
        relevantUntil: new Date(nowMs).toISOString(),
      });
      expect(errorCode(result)).toBe("invalid_args");
      expect(result.kind === "error" && result.message).toContain("already passed");
    });

    test("refuses an unknown citation", async () => {
      expect(errorCode(await note({ summary: "Lease form due", citations: ["doc_missing"] }))).toBe(
        "not_found",
      );
    });

    test("refuses a generated synthesis record as evidence", async () => {
      // The evidence fence treats generated records as unreadable, so they are
      // refused before the generated-record check and read as missing.
      expect(
        errorCode(await note({ summary: "Lease form due", citations: [docId("synth")] })),
      ).toBe("not_found");
      expect(db.prepare("SELECT COUNT(*) AS n FROM observations").get()).toEqual({ n: 0 });
    });

    test("refuses a claim quoting a document it does not cite", async () => {
      const result = await note({
        summary: "Lease form due",
        citations: [docId("lease")],
        claims: [{ docId: docId("dentist"), quote: "dental check-up is confirmed" }],
      });
      expect(errorCode(result)).toBe("invalid_args");
      expect(result.kind === "error" && result.message).toContain("not among citations");
    });

    test("refuses a quote that is not in the cited document", async () => {
      expect(
        errorCode(
          await note({
            summary: "Lease form due",
            citations: [docId("lease")],
            claims: [{ docId: docId("lease"), quote: "the lease was cancelled entirely" }],
          }),
        ),
      ).toBe("evidence_not_found");
    });

    test("stores a grounded observation live, unscored, with unverified claims and deduplicated citations", async () => {
      const lease = docId("lease");
      const relevantUntil = "2026-07-10T17:00:00.000Z";
      const windowStart = "2026-07-08T09:00:00.000Z";
      const result = structured(
        await note({
          summary: "The lease renewal form is due Friday.",
          why: "Missing it may end the tenancy.",
          citations: [lease, lease],
          claims: [{ docId: lease, quote: "renewal form is due back by Friday" }],
          windowStart,
          relevantUntil,
        }),
      );
      expect(result.resultType).toBe("observation.noted");
      expect(result.data).toMatchObject({ id: "obs_id1", userAuthored: false, superseded: [] });
      expect(result.data).not.toHaveProperty("scores");
      const stored = getObservation(db, "obs_id1")!;
      expect(stored).toMatchObject({
        state: "live",
        createdByRun: "run_obs_1",
        summary: "The lease renewal form is due Friday.",
        why: "Missing it may end the tenancy.",
        citations: [lease],
        claims: [
          { docId: lease, quote: "renewal form is due back by Friday", verification: "unverified" },
        ],
        windowStart: Date.parse(windowStart),
        relevantUntil: Date.parse(relevantUntil),
        notedScores: null,
        wouldPushAt: null,
        createdAt: nowMs,
      });
    });

    test("why defaults to empty and windows default to null", async () => {
      structured(await note({ summary: "Dentist on Tuesday", citations: [docId("dentist")] }));
      expect(getObservation(db, "obs_id1")).toMatchObject({
        why: "",
        windowStart: null,
        relevantUntil: null,
      });
    });

    test("is user-authored only when every citation was written by the self person", async () => {
      addPerson("p_self", true);
      addPerson("p_other", false);
      markAuthor(docId("lease"), "p_self");
      markAuthor(docId("dentist"), "p_other", "sender");

      const mine = structured(
        await note({ summary: "Own lease note", citations: [docId("lease")] }),
      );
      expect(mine.data.userAuthored).toBe(true);
      expect(getObservation(db, mine.data.id as string)!.userAuthored).toBe(true);

      const mixed = structured(
        await note({ summary: "Mixed sources", citations: [docId("lease"), docId("dentist")] }),
      );
      expect(mixed.data.userAuthored).toBe(false);

      markAuthor(docId("dentist"), "p_self", "sender");
      const both = structured(
        await note({ summary: "Both mine now", citations: [docId("lease"), docId("dentist")] }),
      );
      expect(both.data.userAuthored).toBe(true);
    });

    test("scores at note time and persists the noted scores and would-push time", async () => {
      const scores = { consequence: 4, timing: 3, alreadyKnown: 0, modelId: "scripted", at: nowMs };
      const scoreObservation = vi.fn(async (_input: ObservationScoringInput) => ({
        scores,
        wouldPushAt: nowMs,
      }));
      tools = build({ scoreObservation });
      const lease = docId("lease");
      const result = structured(
        await note({
          summary: "Lease form due",
          why: "Tenancy at stake",
          citations: [lease],
          relevantUntil: "2026-07-02T18:00:00.000Z",
        }),
      );
      expect(scoreObservation).toHaveBeenCalledExactlyOnceWith({
        id: "obs_id1",
        summary: "Lease form due",
        why: "Tenancy at stake",
        userAuthored: false,
        citations: [lease],
        windowStart: null,
        relevantUntil: Date.parse("2026-07-02T18:00:00.000Z"),
        notedAt: nowMs,
      });
      expect(result.data.scores).toEqual(scores);
      expect(getObservation(db, "obs_id1")).toMatchObject({
        notedScores: scores,
        scores: null,
        wouldPushAt: nowMs,
      });
    });

    test("attaches known loops and reports unknown ones", async () => {
      createOpenLoop(
        db,
        {
          id: "loop_lease",
          createdByRun: "r0",
          title: "Return lease form",
          confidence: 0.9,
          importance: 0.8,
        },
        nowMs,
      );
      const result = structured(
        await note({
          summary: "Lease form due",
          citations: [docId("lease")],
          relatedLoopIds: ["loop_lease", "loop_ghost"],
        }),
      );
      expect(result.data.unknownLoopIds).toEqual(["loop_ghost"]);
      expect(getObservation(db, "obs_id1")!.relatedLoopIds).toEqual(["loop_lease"]);
    });

    test("supersedes open observations and ignores ids that are not open", async () => {
      const base = { createdByRun: "r0", summary: "Older lease note", citations: [docId("lease")] };
      createObservation(db, { ...base, id: "obs_old" }, nowMs - DAY);
      createObservation(db, { ...base, id: "obs_held" }, nowMs - DAY);
      transitionObservation(db, "obs_held", { state: "held", reason: "below_bar" }, nowMs - 1);
      createObservation(db, { ...base, id: "obs_shipped" }, nowMs - DAY);
      transitionObservation(
        db,
        "obs_shipped",
        { state: "shipped", shipped: { conversationId: "c", messageId: "m" } },
        nowMs - 1,
      );
      const result = structured(
        await note({
          summary: "Lease form due Friday",
          citations: [docId("lease")],
          supersedes: ["obs_old", "obs_held", "obs_shipped", "obs_missing"],
        }),
      );
      expect(result.data.superseded).toEqual(["obs_old", "obs_held"]);
      expect(getObservation(db, "obs_old")).toMatchObject({
        state: "dropped",
        closeReason: "superseded",
        closedAt: nowMs,
      });
      expect(getObservation(db, "obs_held")).toMatchObject({
        state: "dropped",
        closeReason: "superseded",
      });
      expect(getObservation(db, "obs_shipped")!.state).toBe("shipped");
      expect(getObservation(db, "obs_id1")!.state).toBe("live");
    });
  });

  describe("observation_withdraw", () => {
    const withdraw = (id: string) => tool("observation_withdraw").invoke({ id }, CTX);

    test("drops an open observation as withdrawn", async () => {
      createObservation(db, { id: "obs_a", createdByRun: "r0", summary: "A" }, nowMs - DAY);
      const result = structured(await withdraw("obs_a"));
      expect(result).toEqual({ resultType: "observation.withdrawn", data: { id: "obs_a" } });
      expect(getObservation(db, "obs_a")).toMatchObject({
        state: "dropped",
        closeReason: "withdrawn",
        closedAt: nowMs,
      });
    });

    test("withdraws a held observation too", async () => {
      createObservation(db, { id: "obs_h", createdByRun: "r0", summary: "H" }, nowMs - DAY);
      transitionObservation(db, "obs_h", { state: "held", reason: "below_bar" }, nowMs - 1);
      structured(await withdraw("obs_h"));
      expect(getObservation(db, "obs_h")!.closeReason).toBe("withdrawn");
    });

    test("refuses a missing or already-terminal observation", async () => {
      expect(errorCode(await withdraw("obs_missing"))).toBe("not_found");
      createObservation(db, { id: "obs_s", createdByRun: "r0", summary: "S" }, nowMs - DAY);
      transitionObservation(
        db,
        "obs_s",
        { state: "shipped", shipped: { conversationId: "c", messageId: "m" } },
        nowMs - 1,
      );
      expect(errorCode(await withdraw("obs_s"))).toBe("not_found");
      expect(getObservation(db, "obs_s")).toMatchObject({ state: "shipped", closeReason: null });
    });

    test("rejects malformed arguments", async () => {
      expect(errorCode(await tool("observation_withdraw").invoke({}, CTX))).toBe("invalid_args");
      expect(
        errorCode(await tool("observation_withdraw").invoke({ id: "obs_a", why: "x" }, CTX)),
      ).toBe("invalid_args");
    });
  });

  describe("observation_list", () => {
    test("lists open observations and only those shipped in the last three days", async () => {
      const lease = docId("lease");
      createObservation(
        db,
        {
          id: "obs_live",
          createdByRun: "r0",
          summary: "Live one",
          why: "w",
          citations: [lease],
          relevantUntil: nowMs + DAY,
        },
        nowMs - 5 * DAY,
      );
      createObservation(
        db,
        { id: "obs_held", createdByRun: "r0", summary: "Held one" },
        nowMs - 4 * DAY,
      );
      transitionObservation(db, "obs_held", { state: "held", reason: "below_bar" }, nowMs - DAY);
      createObservation(
        db,
        { id: "obs_recent", createdByRun: "r0", summary: "Recent" },
        nowMs - 4 * DAY,
      );
      transitionObservation(
        db,
        "obs_recent",
        { state: "shipped", shipped: { conversationId: "c", messageId: "m1" } },
        nowMs - 2 * DAY,
      );
      createObservation(db, { id: "obs_old", createdByRun: "r0", summary: "Old" }, nowMs - 9 * DAY);
      transitionObservation(
        db,
        "obs_old",
        { state: "shipped", shipped: { conversationId: "c", messageId: "m0" } },
        nowMs - 3 * DAY - 1,
      );
      createObservation(
        db,
        { id: "obs_drop", createdByRun: "r0", summary: "Dropped" },
        nowMs - DAY,
      );
      transitionObservation(db, "obs_drop", { state: "dropped", reason: "withdrawn" }, nowMs - 1);

      const result = structured(await tool("observation_list").invoke({}, CTX));
      expect(result.resultType).toBe("observation.list");
      const open = result.data.observations as Array<Record<string, unknown>>;
      expect(open.map((o) => o.id)).toEqual(["obs_live", "obs_held"]);
      expect(open[0]).toEqual({
        id: "obs_live",
        summary: "Live one",
        why: "w",
        state: "live",
        relatedLoopIds: [],
        citations: [lease],
        windowStart: null,
        relevantUntil: new Date(nowMs + DAY).toISOString(),
        notedAt: new Date(nowMs - 5 * DAY).toISOString(),
      });
      expect((result.data.recentlyShipped as Array<{ id: string }>).map((o) => o.id)).toEqual([
        "obs_recent",
      ]);
    });

    test("accepts no arguments and rejects unknown keys", async () => {
      expect(structured(await tool("observation_list").invoke(undefined, CTX)).data).toEqual({
        observations: [],
        recentlyShipped: [],
      });
      expect(errorCode(await tool("observation_list").invoke({ limit: 3 }, CTX))).toBe(
        "invalid_args",
      );
    });
  });
});
