// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { applyExtractedDates } from "../../enrichment/dates/storage.js";
import { insertTemporalAnnotation } from "../../enrichment/temporal-annotations/storage.js";
import { TemporalQueryService } from "../../enrichment/temporal/temporal-query-service.js";
import { createOpenLoop, updateOpenLoop } from "../../brain/storage/open-loops.js";
import { NotesProvenanceService } from "./provenance.js";
import { OMNESIS_NOTES_PROVIDER_ID, OMNESIS_NOTES_SOURCE_ID } from "./source-meta.js";
import type { DocumentInput } from "@omnesis/types";

describe("capture day provenance", () => {
  let db: ReturnType<typeof createDatabase>;
  let service: NotesProvenanceService;
  const day = "2026-10-01";

  beforeEach(() => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    db = createDatabase(":memory:");
    service = new NotesProvenanceService(db);
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });

  function seedDocument(key = day): string {
    const input: DocumentInput = {
      providerId: ProviderId(OMNESIS_NOTES_PROVIDER_ID),
      sourceId: SourceId(OMNESIS_NOTES_SOURCE_ID),
      externalId: key,
      title: "Captured notes",
      content: "Review the studio outline on 12 October 2026.",
      contentHash: `hash-${key}`,
      metadata: {},
      sourceCreatedAt: `${day}T10:00:00.000Z`,
      sourceUpdatedAt: `${day}T10:00:00.000Z`,
    };
    upsertDocuments(db, [input]);
    return db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(key)!.id;
  }

  function seedMention(id: string): void {
    applyExtractedDates(db, [
      {
        id,
        threadKey: null,
        dates: [0, 1].map(() => ({
          kind: "date" as const,
          resolvedStart: "2026-10-12",
          resolvedEnd: null,
          relative: false,
          text: "12 October 2026",
          timex: "2026-10-12",
          charStart: 29,
          charEnd: 44,
        })),
        mentions: [0, 1].map(() => ({
          startDay: "2026-10-12",
          endDay: "2026-10-13",
          deadline: false,
        })),
      },
    ]);
  }

  function seedAnnotation(id: string, documentId: string): void {
    insertTemporalAnnotation(
      db,
      {
        id,
        documentIds: [documentId],
        precision: "day",
        canonical: "2026-10-12",
        intervalStartMs: Date.UTC(2026, 9, 12),
        intervalEndMs: Date.UTC(2026, 9, 13) - 1,
        sentence: "Studio outline review",
        createdByRun: "run_fictional",
      },
      1,
    );
  }

  test("returns an empty result before a day's document is projected", async () => {
    expect(await service.forDay(day)).toEqual({
      day,
      documentId: null,
      mentions: [],
      annotations: [],
      loops: [],
    });
  });

  test("shows deduplicated future mentions with Brain off, and hides stale extraction", async () => {
    const id = seedDocument();
    seedMention(id);
    seedMention(seedDocument("2026-10-02"));
    const result = await service.forDay(day, "America/New_York");
    expect(result.documentId).toBe(id);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]).toMatchObject({
      origin: "mention",
      kind: "event",
      start: "2026-10-12T04:00:00.000Z",
      endExclusive: "2026-10-13T04:00:00.000Z",
    });
    db.prepare("UPDATE documents SET dates_extracted_at = NULL WHERE id = ?").run(id);
    expect((await service.forDay(day)).mentions).toEqual([]);
  });

  test("gates Brain references, excludes invalid annotations, and finds loops updated with this day", async () => {
    const id = seedDocument();
    seedAnnotation("ta_live", id);
    seedAnnotation("ta_invalid", id);
    db.prepare("UPDATE temporal_annotations SET invalidated_at = 2 WHERE id = ?").run("ta_invalid");
    const other = seedDocument("2026-10-02");
    seedAnnotation("ta_other", other);
    createOpenLoop(
      db,
      {
        id: "loop_updated",
        createdByRun: "run_fictional",
        title: "Review outline",
        confidence: 1,
        importance: 1,
        docs: [other],
      },
      1,
    );
    updateOpenLoop(db, "loop_updated", { docs: [other, id], state: "done" }, 2);
    createOpenLoop(
      db,
      {
        id: "loop_other",
        createdByRun: "run_fictional",
        title: "Other obligation",
        confidence: 1,
        importance: 1,
        docs: [other],
      },
      1,
    );
    expect((await service.forDay(day)).annotations).toEqual([]);
    expect((await service.forDay(day)).loops).toEqual([]);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    const result = await service.forDay(day);
    expect(result.annotations.map((item) => item.id)).toEqual(["ta_live"]);
    expect(result.annotations[0]).toMatchObject({ origin: "annotation", kind: expect.any(String) });
    expect(result.loops).toEqual([{ id: "loop_updated", title: "Review outline", status: "done" }]);
  });

  test("reads every page when a day's references exceed the temporal page size", async () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    const id = seedDocument();
    for (let i = 0; i < 105; i += 1) seedAnnotation(`ta_${String(i).padStart(3, "0")}`, id);
    expect((await service.forDay(day)).annotations).toHaveLength(105);
  });

  test("retains more than one page of distinct mentions with shared deep-link IDs and date bounds", async () => {
    const id = seedDocument();
    const days = Array.from({ length: 106 }, (_, index) =>
      new Date(Date.UTC(2027, 0, 1 + index)).toISOString().slice(0, 10),
    );
    applyExtractedDates(db, [
      {
        id,
        threadKey: null,
        dates: days.slice(0, -1).map((startDay) => ({
          kind: "date" as const,
          resolvedStart: startDay,
          resolvedEnd: null,
          relative: false,
          text: startDay,
          timex: startDay,
          charStart: 0,
          charEnd: 10,
        })),
        mentions: days.slice(0, -1).map((startDay, index) => ({
          startDay,
          endDay: days[index + 1]!,
          deadline: false,
        })),
      },
    ]);
    const mentions = (await service.forDay(day, "America/New_York")).mentions;
    expect(mentions).toHaveLength(105);
    expect(new Set(mentions.map((mention) => mention.id)).size).toBe(105);
    expect(mentions.map((mention) => mention.start.slice(0, 10))).toEqual(days.slice(0, -1));
    const final = mentions[104]!;
    const detail = await new TemporalQueryService(db).itemById(final.id, "America/New_York");
    expect(detail).toMatchObject(final);
    expect(final).toMatchObject({
      start: "2027-04-15T04:00:00.000Z",
      endExclusive: "2027-04-16T04:00:00.000Z",
    });
  });

  test("finds a distant coarse annotation outside the capture year", async () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    const id = seedDocument();
    insertTemporalAnnotation(
      db,
      {
        id: "ta_distant",
        documentIds: [id],
        precision: "month",
        canonical: "2031-02",
        intervalStartMs: Date.UTC(2031, 1, 1),
        intervalEndMs: Date.UTC(2031, 2, 1) - 1,
        sentence: "Long-range outline review",
        createdByRun: "run_fictional",
      },
      1,
    );
    expect((await service.forDay(day, "America/New_York")).annotations).toEqual([
      {
        id: "ta_distant",
        origin: "annotation",
        kind: "event",
        label: "Long-range outline review",
        start: "2031-02-01T05:00:00.000Z",
        endExclusive: "2031-03-01T05:00:00.000Z",
      },
    ]);
  });
});
