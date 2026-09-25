// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading a threshold's verdict.
 *
 * The arithmetic decides whether an operator is told their watch is fine, and
 * it is the part that can be wrong quietly: a probe that reported a healthy
 * nomination count for a watch that would never fire is worse than no probe,
 * because it converts an open question into a wrong answer.
 *
 * So what is pinned is the shape of the verdict rather than the percentiles —
 * a watch that caught nothing says by how much it missed, a watch that caught
 * everything does not pretend there is headroom, and an empty window is
 * distinguishable from a window full of documents that all scored zero.
 *
 * Fixture data is invented — no corpus content.
 */

import SqliteDatabase from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { summariseProbe } from "./probe.js";
import { probeArm, semanticArms } from "./probe-run.js";

describe("what the scores say about a threshold", () => {
  it("says how far a watch that caught nothing missed by", () => {
    // The case the probe exists for. "Best 0.31 against a threshold of 0.35"
    // is a number an operator can act on; "0 nominated" alone is not.
    const s = summariseProbe([0.11, 0.29, 0.31], 0.35);

    expect(s.nominated).toBe(0);
    expect(s.shortfall).toBeCloseTo(0.04, 5);
    expect(s.best).toBeCloseTo(0.31, 5);
  });

  it("reports no shortfall when something already clears", () => {
    const s = summariseProbe([0.11, 0.42], 0.35);

    expect(s.nominated).toBe(1);
    expect(s.shortfall).toBe(0);
  });

  it("names the next document down, so the headroom is visible", () => {
    // How much room there is before the next document joins. A threshold with
    // a crowd just underneath is a different risk from one with a gap.
    const s = summariseProbe([0.2, 0.349, 0.5], 0.35);

    expect(s.nominated).toBe(1);
    expect(s.nextThreshold).toBeCloseTo(0.349, 5);
  });

  it("claims no headroom when every document cleared", () => {
    expect(summariseProbe([0.4, 0.5], 0.35).nextThreshold).toBeNull();
  });

  it("distinguishes an empty window from documents that all scored zero", () => {
    // Both nominate nothing and only one is a threshold problem. A window with
    // nothing in it says the probe could not answer; a window of zeros says the
    // arm is asking the wrong question.
    const empty = summariseProbe([], 0.35);
    const zeros = summariseProbe([0, 0, 0], 0.35);

    expect(empty.considered).toBe(0);
    expect(empty.shortfall, "an empty window claimed a shortfall it could not know").toBeNull();
    expect(zeros.considered).toBe(3);
    expect(zeros.shortfall).toBeCloseTo(0.35, 5);
  });
});

describe("which arms a watch offers to a probe", () => {
  const arm = (recall: unknown) => ({
    watch: {
      nodes: [{ id: "mail", type: "source.document_event", filter: { source: "gmail" }, recall }],
    },
  });

  it("reads the query and threshold the watch is running", () => {
    // Read from the stored definition rather than a file: the install's copy
    // is the authority, and a local file may have drifted from it.
    const arms = semanticArms(arm({ semantic: { query: "a shipping notice", threshold: 0.4 } }));

    expect(arms).toHaveLength(1);
    expect(arms[0]).toMatchObject({ nodeId: "mail", query: "a shipping notice", threshold: 0.4 });
  });

  it("offers nothing for an arm with no semantic half", () => {
    // A lexical arm has no threshold to be wrong about — its terms either
    // appear or they do not — so probing it would report a verdict on nothing.
    expect(semanticArms(arm({ lexical: { terms: ["TOKEN"], match: "token" } }))).toEqual([]);
    expect(semanticArms(arm(undefined))).toEqual([]);
  });

  it("offers nothing for a definition it cannot read", () => {
    expect(semanticArms(null)).toEqual([]);
    expect(semanticArms({ watch: { nodes: "not a list" } })).toEqual([]);
  });
});

describe("running an arm over a corpus", () => {
  /**
   * A real SQLite pair, not a stubbed `prepare`.
   *
   * The candidate query is the half that decides what the numbers mean, and a
   * stub over it is how a probe that matched nothing on any multi-account
   * install passed its own suite: `filter.source` names a bare type, and a
   * document's `source_id` carries `type:account`.
   */
  function corpus(
    docs: { id: string; sourceId: string; type?: string; createdAt?: string }[],
    scores: Record<string, number> = {},
    options: { indexed?: boolean } = {},
  ) {
    const db = new SqliteDatabase(":memory:");
    db.exec(
      `CREATE TABLE documents (id TEXT PRIMARY KEY, provider_id TEXT, source_id TEXT,
         metadata TEXT, source_created_at TEXT)`,
    );
    const indexDb = new SqliteDatabase(":memory:");
    indexDb.exec("CREATE TABLE chunks (document_id TEXT, embedding BLOB)");
    for (const doc of docs) {
      db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?)").run(
        doc.id,
        doc.sourceId.split(":")[0],
        doc.sourceId,
        JSON.stringify({ documentType: doc.type ?? "email" }),
        doc.createdAt ?? "2026-03-01T00:00:00.000Z",
      );
      if (options.indexed !== false) {
        indexDb.prepare("INSERT INTO chunks VALUES (?, ?)").run(doc.id, Buffer.from([1, 2, 3, 4]));
      }
    }
    return {
      db: db as never,
      indexDb: indexDb as never,
      canScore: () => true,
      recall: {
        score: (request: { documentId: string }) =>
          Promise.resolve(scores[request.documentId] ?? 0),
      },
      now: () => Date.parse("2026-03-04T00:00:00.000Z"),
    };
  }

  const arm = (over: Partial<Parameters<typeof probeArm>[1]> = {}) => ({
    nodeId: "mail",
    query: "a shipping notice",
    threshold: 0.35,
    sources: ["gmail"],
    documentTypes: ["email"],
    ...over,
  });

  it("matches every account under a bare source, as the runtime does", async () => {
    // The defect this test exists for. A watch filtering `gmail` matches
    // `gmail:someone` at runtime; a probe matching on equality alone saw none
    // of them and reported "nothing to score", which reads as a broken filter
    // on a watch that is working perfectly.
    const deps = corpus(
      [
        { id: "a", sourceId: "gmail:maya@example.com" },
        { id: "b", sourceId: "gmail:jamie@example.org" },
        { id: "c", sourceId: "gmail" },
      ],
      { a: 0.5, b: 0.1, c: 0.9 },
    );

    const result = await probeArm(deps, arm(), { windowDays: 90, limit: 100 });

    expect(result.considered, "accounts under a bare source were not considered").toBe(3);
    expect(result.nominated).toBe(2);
  });

  it("keeps an account-qualified source exact", async () => {
    const deps = corpus(
      [
        { id: "a", sourceId: "gmail:maya@example.com" },
        { id: "b", sourceId: "gmail:jamie@example.org" },
      ],
      { a: 0.5, b: 0.5 },
    );

    const result = await probeArm(deps, arm({ sources: ["gmail:maya@example.com"] }), {
      windowDays: 90,
      limit: 100,
    });

    expect(result.considered).toBe(1);
  });

  it("does not admit a different source that merely starts the same", async () => {
    const deps = corpus([{ id: "a", sourceId: "gmailish:someone" }], { a: 0.9 });

    expect((await probeArm(deps, arm(), { windowDays: 90, limit: 100 })).considered).toBe(0);
  });

  it("leaves out a document nothing has embedded", async () => {
    // A semantic arm waits for indexing, so the runtime never looks at these.
    // Scoring them as zero pads the denominator with documents no watch would
    // ever have seen and drags the distribution down with them.
    const deps = corpus(
      [{ id: "a", sourceId: "gmail:maya@example.com" }],
      { a: 0.9 },
      {
        indexed: false,
      },
    );

    expect((await probeArm(deps, arm(), { windowDays: 90, limit: 100 })).considered).toBe(0);
  });

  it("excludes a document of the wrong type in the query, not afterwards", async () => {
    // Filtering after the LIMIT would spend the whole budget on documents it
    // then throws away, and report the remainder as if it were the window.
    const deps = corpus(
      [
        { id: "a", sourceId: "gmail:maya@example.com", type: "calendar_event" },
        { id: "b", sourceId: "gmail:maya@example.com", type: "email" },
      ],
      { a: 0.9, b: 0.9 },
    );

    const result = await probeArm(deps, arm(), { windowDays: 90, limit: 1 });

    expect(result.considered).toBe(1);
    expect(result.capped, "the wrong-typed document ate the budget").toBe(false);
  });

  it("leaves out anything older than the window", async () => {
    const deps = corpus(
      [
        { id: "old", sourceId: "gmail:maya@example.com", createdAt: "2025-01-01T00:00:00.000Z" },
        { id: "new", sourceId: "gmail:maya@example.com" },
      ],
      { old: 0.9, new: 0.9 },
    );

    expect((await probeArm(deps, arm(), { windowDays: 30, limit: 100 })).considered).toBe(1);
  });

  it("says when it stopped early, so a thin answer reads as thin", async () => {
    // A capped probe has seen a slice of the window, and a nomination count
    // from a slice is not the count for the window. Reporting the cap is what
    // stops "0 nominated" being read as "would never fire".
    const deps = corpus(
      [
        { id: "a", sourceId: "gmail:maya@example.com" },
        { id: "b", sourceId: "gmail:maya@example.com" },
        { id: "c", sourceId: "gmail:maya@example.com" },
      ],
      {},
    );

    const result = await probeArm(deps, arm(), { windowDays: 90, limit: 2 });

    expect(result.capped).toBe(true);
    expect(result.considered).toBe(2);
  });
});
