// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrainSourceFence, type BrainSourceFence } from "../source-exclusion.js";
import {
  EXCLUDED_SOURCE_ERROR_CODE,
  existingPageCitations,
  fenceExcludedDocumentArguments,
  fenceReadPorts,
  fenceTemporalResult,
} from "./source-fence.js";
import type { DocRef, EventTrail, TemporalQueryResult, TrailEvent } from "@omnesis/core";
import type { SqlPort, ToolHandle, ToolPorts } from "@omnesis/agent";

let db: Database.Database;
let excluded: string[];
let fence: BrainSourceFence;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY, source_id TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO documents VALUES(?,?)");
  insert.run("doc-session", "codex:local");
  insert.run("doc-mail", "gmail:maya@example.com");
  insert.run("doc-note", "notes");
  excluded = ["codex"];
  fence = createBrainSourceFence(db, () => excluded);
});
afterEach(() => db.close());

function ref(documentId: string, sourceId: string, extra: Partial<DocRef> = {}): DocRef {
  return { documentId, sourceId, sourceType: sourceId.split(":")[0]!, title: documentId, ...extra };
}

function event(documentId: string, sourceId: string, extra: Partial<TrailEvent> = {}): TrailEvent {
  return {
    eventId: documentId,
    at: null,
    kind: "document",
    doc: { documentId, sourceId, title: documentId },
    attachments: [],
    people: [],
    related: [],
    ...extra,
  };
}

function ports(): ToolPorts & { searchedLimits: Array<number | undefined> } {
  const searchedLimits: Array<number | undefined> = [];
  const refs = [
    ref("doc-session", "codex:local"),
    ref("doc-mail", "gmail:maya@example.com", {
      breadcrumb: [
        { documentId: "doc-session", edge: "reference" },
        { documentId: "doc-note", edge: "reference" },
      ],
      provenance: {
        summary: "Two copies",
        copies: [
          { documentId: "doc-session", sourceId: "codex:local" },
          { documentId: "doc-mail", sourceId: "gmail:maya@example.com" },
        ],
      } as NonNullable<DocRef["provenance"]>,
    }),
    ref("doc-note", "notes"),
  ];
  return {
    searchedLimits,
    search: {
      async search(input) {
        searchedLimits.push(input.limit);
        return { query: input.query, durationMs: 1, results: refs.slice(0, input.limit ?? 10) };
      },
    },
    document: {
      requiresCitationRead: true,
      async fetch(documentId) {
        const hit = refs.find((candidate) => candidate.documentId === documentId);
        return hit
          ? { ref: hit, document: { id: documentId }, neighbors: refs.filter((r) => r !== hit) }
          : null;
      },
    },
    documentByUrl: {
      async lookup(url) {
        return { url, durationMs: 1, ref: refs[0]! };
      },
    },
    trail: {
      async build(seedIds): Promise<EventTrail> {
        return {
          seeds: [...seedIds],
          events: [
            event("doc-mail", "gmail:maya@example.com", {
              attachments: [event("doc-session", "codex:local")],
              related: [
                {
                  documentId: "doc-session",
                  title: "session",
                  sourceId: "codex:local",
                  linkType: "reference",
                  direction: "out",
                },
              ],
            }),
            event("doc-session", "codex:local"),
          ],
          truncated: false,
          stats: { visited: 3, elapsedMs: 1, maxDepthReached: 1 },
        };
      },
    },
    entityContext: {
      async reap(seed) {
        return {
          seed: { kind: seed.kind, id: seed.id, label: seed.id },
          loops: [],
          documents: [
            { documentId: "doc-session" },
            { documentId: "doc-mail", sourceId: "gmail:maya@example.com" },
          ],
          people: [],
          temporalAnnotations: [],
          truncated: false,
          counts: { loops: 0, documents: 2, people: 0, temporalAnnotations: 0 },
        };
      },
    },
  };
}

describe("fenceReadPorts", () => {
  it("drops excluded search hits and their nested references, over-fetching to fill the page", async () => {
    const base = ports();
    const fenced = fenceReadPorts(base, fence);
    const result = await fenced.search.search({ query: "plan", limit: 2 });
    expect(base.searchedLimits).toEqual([4]);
    expect(result.results.map((r) => r.documentId)).toEqual(["doc-mail", "doc-note"]);
    expect(result.results[0]!.breadcrumb?.map((crumb) => crumb.documentId)).toEqual(["doc-note"]);
    // Graph-context provenance touching an excluded document is dropped whole.
    expect(result.results[0]!.provenance).toBeUndefined();
  });

  it("reads an excluded document as not found and keeps its flags", async () => {
    const fenced = fenceReadPorts(ports(), fence);
    expect(fenced.document.requiresCitationRead).toBe(true);
    expect(await fenced.document.fetch("doc-session")).toBeNull();
    const mail = await fenced.document.fetch("doc-mail");
    expect(mail?.neighbors?.map((n) => n.documentId)).toEqual(["doc-note"]);
    expect((await fenced.documentByUrl!.lookup("https://example.com/a")).ref).toBeUndefined();
  });

  it("removes excluded seeds and events from a connection trace", async () => {
    const fenced = fenceReadPorts(ports(), fence);
    expect(await fenced.trail!.build(["doc-session"])).toMatchObject({ seeds: [], events: [] });
    const trail = await fenced.trail!.build(["doc-mail", "doc-session"]);
    expect(trail.events.map((e) => e.doc?.documentId)).toEqual(["doc-mail"]);
    expect(trail.events[0]!.attachments).toEqual([]);
    expect(trail.events[0]!.related).toEqual([]);
  });

  it("empties entity context seeded on an excluded document and filters the rest", async () => {
    const fenced = fenceReadPorts(ports(), fence);
    expect(await fenced.entityContext!.reap({ kind: "document", id: "doc-session" })).toMatchObject(
      { seed: null, documents: [] },
    );
    const context = await fenced.entityContext!.reap({ kind: "person", id: "person-1" });
    expect(context.documents.map((d) => d.documentId)).toEqual(["doc-mail"]);
    expect(context.counts.documents).toBe(1);
  });

  it("scopes SQL to the tables of the remaining sources", async () => {
    const scopes: Array<ReadonlySet<string>> = [];
    const unscoped: SqlPort = {
      run: async () => {
        throw new Error("unscoped port used while a source is excluded");
      },
    };
    const fenced = fenceReadPorts({ ...ports(), sql: unscoped }, fence, {
      catalogSourceIds: async () => ["codex:local", "bank:main"],
      sqlPortFor: (permitted) => {
        scopes.push(permitted);
        return { run: async (sql) => ({ sql, columns: [], rows: [], rowCount: 0 }) as never };
      },
    });
    await fenced.sql!.run("SELECT 1");
    expect(scopes.map((scope) => [...scope])).toEqual([["bank:main"]]);
  });

  it("passes everything through when nothing is excluded", async () => {
    excluded = [];
    const base = ports();
    const fenced = fenceReadPorts(base, fence);
    expect((await fenced.search.search({ query: "plan", limit: 2 })).results).toHaveLength(2);
    expect(base.searchedLimits).toEqual([2]);
    expect(await fenced.document.fetch("doc-session")).not.toBeNull();
  });
});

describe("fenceTemporalResult", () => {
  it("drops projections and mentions from excluded sources and unlinks excluded evidence", () => {
    const base = {
      start: "2027-01-01",
      endExclusive: "2027-01-02",
      precision: "day",
      allDay: true,
      kind: "event",
      modality: "scheduled",
      status: "confirmed",
    } as const;
    const result = {
      type: "temporal.results",
      window: { start: "2027-01-01", endExclusive: "2027-02-01", timeZone: "UTC" },
      items: [
        {
          ...base,
          id: "projection",
          origin: "projection",
          label: "Session",
          projection: { sourceId: "codex:local", slot: "start", projectedAt: "x", revision: "1" },
        },
        {
          ...base,
          id: "mention",
          origin: "mention",
          label: "Session mention",
          mention: {
            documentId: "doc-session",
            sourceId: "codex:local",
            text: "Friday",
            relative: false,
          },
        },
        {
          ...base,
          id: "annotation",
          origin: "annotation",
          label: "Workshop",
          annotation: {
            documentIds: ["doc-session", "doc-mail"],
            personIds: [],
            loopIds: [],
            projectionIds: [],
            createdByRun: "run-1",
            revision: 1,
            createdAt: "x",
            updatedAt: "x",
          },
        },
      ],
      summary: { anchored: 3, spanning: 0 },
      coverage: {
        projectionSources: [
          { sourceId: "codex:local", slots: [] },
          { sourceId: "calendar:maya@example.com", slots: [] },
        ],
        specialistSources: [],
        annotations: { selective: true },
      },
      truncated: false,
    } as unknown as TemporalQueryResult;
    const fenced = fenceTemporalResult(result, fence);
    expect(fenced.items.map((item) => item.id)).toEqual(["annotation"]);
    expect(fenced.items[0]!.annotation!.documentIds).toEqual(["doc-mail"]);
    expect(fenced.coverage.projectionSources.map((s) => s.sourceId)).toEqual([
      "calendar:maya@example.com",
    ]);
  });
});

function insertNote() {
  db.prepare("INSERT INTO documents VALUES('doc-other','codex:workstation')").run();
}

describe("fenceExcludedDocumentArguments", () => {
  const calls: unknown[] = [];
  const tool: ToolHandle = {
    name: "annotate_durable",
    description: "test",
    schema: z.unknown(),
    mutates: true,
    async invoke(args) {
      calls.push(args);
      return { kind: "structured", resultType: "ok", data: {} } as never;
    },
  };
  beforeEach(() => {
    calls.length = 0;
  });

  it.each([
    [{ docId: "doc-session", quote: "x" }],
    [{ evidence: [{ docId: "doc-mail" }, { docId: "doc-session" }] }],
    [{ docs: ["doc-mail", "doc-session"] }],
    [{ node: { inputVersions: { "source:doc-session": "v1" } } }],
    [{ markdown: '<claim id="a" refs="source:doc-session#evidence:e1">Fact.</claim>' }],
    [{ id: "source:doc-session", inputFingerprint: "f" }],
  ])("refuses a call naming an excluded document: %j", async (args) => {
    const [fenced] = fenceExcludedDocumentArguments([tool], fence);
    expect(fenced!.mutates).toBe(true);
    const result = await fenced!.invoke(args, {} as never);
    expect(result).toMatchObject({ kind: "error", code: EXCLUDED_SOURCE_ERROR_CODE });
    expect((result as { message: string }).message).toContain("doc-session");
    expect(calls).toEqual([]);
  });

  it("refuses arguments too large or too deep to check", async () => {
    const [fenced] = fenceExcludedDocumentArguments([tool], fence);
    let deep: unknown = "doc-mail";
    for (let i = 0; i < 20; i++) deep = [deep];
    expect(await fenced!.invoke({ docs: deep }, {} as never)).toMatchObject({
      code: EXCLUDED_SOURCE_ERROR_CODE,
    });
    const many = Array.from({ length: 5000 }, (_, i) => `doc-${i}`);
    expect(await fenced!.invoke({ docs: many }, {} as never)).toMatchObject({
      code: EXCLUDED_SOURCE_ERROR_CODE,
    });
    expect(calls).toEqual([]);
  });

  it("lets a call carry citations its target already rests on, but no new one", async () => {
    const [fenced] = fenceExcludedDocumentArguments([tool], fence, () => new Set(["doc-session"]));
    await fenced!.invoke({ markdown: 'refs="source:doc-session"' }, {} as never);
    expect(calls).toHaveLength(1);
    insertNote();
    expect(
      await fenced!.invoke({ markdown: 'refs="source:doc-session source:doc-other"' }, {} as never),
    ).toMatchObject({ code: EXCLUDED_SOURCE_ERROR_CODE });
  });

  it("runs a call that names only other documents, and any call once the exclusion is lifted", async () => {
    const [fenced] = fenceExcludedDocumentArguments([tool], fence);
    await fenced!.invoke({ docId: "doc-mail", quote: "open source: notes" }, {} as never);
    excluded = [];
    await fenced!.invoke({ docId: "doc-session" }, {} as never);
    expect(calls).toHaveLength(2);
  });
});

describe("existingPageCitations", () => {
  it("names a page's cited sources for a full save and a targeted edit alike", () => {
    db.exec(
      "CREATE TABLE knowledge_dependencies(node_id TEXT, target_id TEXT, target_kind TEXT); INSERT INTO knowledge_dependencies VALUES('page','doc-session','source'),('page','other-page','node')",
    );
    const cited = existingPageCitations(db);
    for (const tool of ["knowledge_save", "knowledge_edit"])
      expect([...cited(tool, { node: { id: "page" } })], tool).toEqual(["doc-session"]);
    expect(cited("annotate_durable", { node: { id: "page" } }).size).toBe(0);
    expect(cited("knowledge_edit", { node: {} }).size).toBe(0);
  });

  it("lets an edit replace text holding an existing citation but refuses a new one", async () => {
    db.exec(
      "CREATE TABLE knowledge_dependencies(node_id TEXT, target_id TEXT, target_kind TEXT); INSERT INTO knowledge_dependencies VALUES('page','doc-session','source')",
    );
    insertNote();
    const edits: unknown[] = [];
    const edit: ToolHandle = {
      name: "knowledge_edit",
      description: "test",
      schema: z.unknown(),
      mutates: true,
      async invoke(args) {
        edits.push(args);
        return { kind: "structured", resultType: "ok", data: {} } as never;
      },
    };
    const [fenced] = fenceExcludedDocumentArguments([edit], fence, existingPageCitations(db));
    const args = (refs: string) => ({
      node: {
        id: "page",
        expectedRevision: 1,
        edits: [
          {
            op: "replace_text",
            old: '<claim id="a" refs="source:doc-session">',
            new: `<claim id="a" refs="${refs}">`,
          },
        ],
      },
    });
    expect(
      await fenced!.invoke(args("source:doc-session source:doc-mail"), {} as never),
    ).toMatchObject({
      kind: "structured",
    });
    expect(
      await fenced!.invoke(args("source:doc-session source:doc-other"), {} as never),
    ).toMatchObject({
      kind: "error",
      code: EXCLUDED_SOURCE_ERROR_CODE,
      message: expect.stringContaining("doc-other"),
    });
    expect(edits).toHaveLength(1);
  });
});
