// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hostTimeZone } from "@omnesis/core";
import { createIndexDatabase, EMBEDDING_DIM, upsertChunks } from "../indexer/db.js";
import { SearchPipeline } from "./pipeline.js";
import { closeTempDb } from "./test-utils.js";
import type Database from "better-sqlite3";
import type { TemporalItem, TemporalQueryInput } from "@omnesis/core";
import type { VectorReadSource } from "../indexer/usearch-index.js";
import type { SearchConfig } from "./search-config.js";

// Wednesday 7 October 2026, morning in London.
const NOW = new Date("2026-10-07T09:00:00Z");

const zero = new Float32Array(EMBEDDING_DIM);

function seed(db: Database.Database): void {
  const chunk = (documentId: string, content: string, sourceCreatedAt: string) => ({
    id: `${documentId}-0`,
    documentId,
    chunkIndex: 0,
    content,
    embedding: zero,
    sourceId: "gmail:maya@example.com",
    documentType: "email",
    title: content,
    sourceCreatedAt,
  });
  upsertChunks(db, [
    // Many older invoices outrank on words alone…
    chunk("old-1", "invoice invoice from Northstar", "2026-03-02T10:00:00Z"),
    chunk("old-2", "invoice invoice reminder Northstar", "2026-04-02T10:00:00Z"),
    chunk("old-3", "invoice invoice overdue Northstar", "2026-05-02T10:00:00Z"),
    // …than last week's.
    chunk("last-week", "your invoice from Northstar", "2026-09-30T10:00:00Z"),
    // Sent in August, about tomorrow.
    chunk("about-tomorrow", "appointment confirmation for the dentist", "2026-08-20T10:00:00Z"),
  ]);
}

function mentionItems(documentIds: string[]): TemporalItem[] {
  return documentIds.map(
    (documentId, i) =>
      ({
        id: `dm_${i}`,
        origin: "mention",
        start: "2026-10-07T23:00:00.000Z",
        endExclusive: "2026-10-08T23:00:00.000Z",
        anchored: true,
        precision: "day",
        allDay: true,
        label: "8 October",
        kind: "event",
        modality: "asserted",
        status: "active",
        mention: {
          documentId,
          sourceId: "gmail:maya@example.com",
          text: "8 October",
          relative: false,
        },
      }) as TemporalItem,
  );
}

describe("SearchPipeline temporal lane", () => {
  let db: Database.Database;
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterAll(() => vi.useRealTimers());
  beforeEach(() => {
    db = createIndexDatabase(`/tmp/omnesis-temporal-pipeline-${randomUUID()}.db`);
    seed(db);
  });
  afterEach(() => closeTempDb(db));

  const pipeline = (searchConfig: SearchConfig = {}) => {
    const p = new SearchPipeline({ indexDb: db, searchConfig });
    const seen: TemporalQueryInput[] = [];
    p.setTemporalIndex(
      {
        async anchoredItems(input) {
          seen.push(input);
          return mentionItems(["about-tomorrow"]);
        },
      },
      "day-first",
    );
    return { p, seen };
  };

  it("is on by default, and off when the config says so", async () => {
    const on = await pipeline().p.search({ text: "invoice last week", timeZone: "Europe/London" });
    expect(on.stages?.temporal?.status).toBe("ran");

    const { p, seen } = pipeline({ temporal: { enabled: false } });
    const off = await p.search({ text: "invoice last week", timeZone: "Europe/London" });
    expect(off.stages?.temporal).toBeUndefined();
    expect(off.query.temporal).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("lifts the document inside the named window and reports what it read", async () => {
    const { p } = pipeline({ temporal: { enabled: true } });
    const r = await p.search({ text: "invoice last week", timeZone: "Europe/London" });

    expect(r.query.temporal).toEqual({
      windows: [
        {
          start: "2026-09-27T23:00:00.000Z",
          endExclusive: "2026-10-04T23:00:00.000Z",
          text: "last week",
        },
      ],
      strippedText: "invoice",
      timeZone: "Europe/London",
    });
    expect(r.stages?.temporal).toMatchObject({
      status: "ran",
      ranking: "relevance",
      candidates: 1,
    });
    expect(r.stages?.fusion).toMatchObject({ temporalWeight: 1 });
    expect(r.results[0]!.documentId).toBe("last-week");
    expect(r.results[0]!.scoreBreakdown?.temporalRank).toBe(1);
  });

  it("reaches documents about the window through the time index", async () => {
    const { p, seen } = pipeline({ temporal: { enabled: true } });
    const r = await p.search({ text: "dentist tomorrow", timeZone: "Europe/London" });

    expect(seen[0]).toMatchObject({
      from: "2026-10-07T23:00:00.000Z",
      to: "2026-10-08T23:00:00.000Z",
      timeZone: "Europe/London",
    });
    expect(r.stages?.temporal).toMatchObject({ eventDocuments: 1 });
    expect(r.results[0]!.documentId).toBe("about-tomorrow");
  });

  it("follows a per-request override either way", async () => {
    const off = pipeline({ temporal: { enabled: true } }).p;
    const without = await off.search({
      text: "invoice last week",
      timeZone: "Europe/London",
      temporal: { enabled: false },
    });
    expect(without.stages?.temporal).toBeUndefined();

    const on = pipeline({ temporal: { enabled: false } }).p;
    const withLane = await on.search({
      text: "invoice last week",
      timeZone: "Europe/London",
      temporal: { enabled: true, weight: 2 },
    });
    expect(withLane.stages?.fusion).toMatchObject({ temporalWeight: 2 });
  });

  it("reads relative dates as of a given reference time", async () => {
    const { p } = pipeline({ temporal: { enabled: true } });
    const r = await p.search({
      text: "invoice last week",
      timeZone: "Europe/London",
      temporal: { referenceTime: "2026-09-02T12:00:00Z" },
    });
    expect(r.query.temporal?.windows[0]).toMatchObject({
      start: "2026-08-23T23:00:00.000Z",
      endExclusive: "2026-08-30T23:00:00.000Z",
    });
  });

  it("keeps a query's own date filter on top of the window", async () => {
    const { p } = pipeline({ temporal: { enabled: true } });
    const r = await p.search({
      text: "invoice after:2026-04-01 last week",
      timeZone: "Europe/London",
    });
    expect(r.query.temporal?.strippedText).toBe("invoice");
    expect(r.stages?.temporal?.status).toBe("ran");
    const ids = r.results.map((x) => x.documentId);
    expect(ids[0]).toBe("last-week");
    // March's invoice is before the filter, whatever the lane makes of it.
    expect(ids).not.toContain("old-1");
  });

  it("leaves a query that names no time to the text lanes", async () => {
    const { p, seen } = pipeline({ temporal: { enabled: true } });
    const r = await p.search({ text: "Northstar invoice", timeZone: "Europe/London" });
    expect(r.stages?.temporal).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("reads the query in the host's zone when the given one is not a zone", async () => {
    const { p } = pipeline({ temporal: { enabled: true } });
    const r = await p.search({ text: "invoice last week", timeZone: "Mars/Olympus_Mons" });
    expect(r.query.temporal?.timeZone).toBe(hostTimeZone());
    expect(r.stages?.temporal?.status).toBe("ran");
  });

  describe("with an embedder", () => {
    const usearch: VectorReadSource = {
      search: () => [],
      maybeRefresh: () => {},
      size: () => 0,
    };
    const embedder = (embedQuery: (text: string) => Promise<Float32Array>) => ({
      async embed(texts: string[]) {
        return texts.map(() => new Float32Array(EMBEDDING_DIM).fill(0.01));
      },
      embedQuery,
      async dispose() {},
    });

    it("embeds the query without its time phrase for the lane", async () => {
      const p = new SearchPipeline({
        indexDb: db,
        usearchRead: usearch,
        searchConfig: { temporal: { enabled: true } },
      });
      const asked: string[] = [];
      p.setEmbedder(
        embedder(async (text) => {
          asked.push(text);
          return new Float32Array(EMBEDDING_DIM).fill(0.01);
        }),
      );
      const r = await p.search({ text: "invoice last week", timeZone: "Europe/London" });
      expect(asked.sort()).toEqual(["invoice", "invoice last week"]);
      expect(r.stages?.temporal?.status).toBe("ran");
    });

    it("ranks the window by words when the lane's embedding fails", async () => {
      const p = new SearchPipeline({
        indexDb: db,
        usearchRead: usearch,
        searchConfig: { temporal: { enabled: true } },
      });
      p.setEmbedder(
        embedder(async (text) => {
          if (text === "invoice") throw new Error("embedder overloaded");
          return new Float32Array(EMBEDDING_DIM).fill(0.01);
        }),
      );
      const r = await p.search({ text: "invoice last week", timeZone: "Europe/London" });
      expect(r.stages?.temporal?.status).toBe("ran");
      expect(r.results[0]!.documentId).toBe("last-week");
    });

    it("gives the lane no vector when the vector lane could not run", async () => {
      // No HNSW index: the vector lane is skipped, so the lane ranks by words.
      const p = new SearchPipeline({ indexDb: db, searchConfig: { temporal: { enabled: true } } });
      p.setEmbedder(embedder(async () => new Float32Array(EMBEDDING_DIM).fill(0.01)));
      const r = await p.search({ text: "invoice last week", timeZone: "Europe/London" });
      expect(r.stages?.vector?.status).toBe("skipped");
      expect(r.stages?.temporal?.status).toBe("ran");
    });
  });
});
