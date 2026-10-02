// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { experimentalEnabled, MAX_TIME_ZONE_SHIFT_MS } from "@omnesis/core";
import { TemporalQueryService } from "../../enrichment/temporal/temporal-query-service.js";
import { OMNESIS_NOTES_PROVIDER_ID, OMNESIS_NOTES_SOURCE_ID } from "./source-meta.js";
import type Database from "better-sqlite3";
import type { TemporalItem } from "@omnesis/core";
import type { OpenLoopState } from "../../brain/storage/types.js";

type TemporalReference = Pick<TemporalItem, "id" | "label" | "start" | "endExclusive">;

export interface NotesDayProvenance {
  day: string;
  documentId: string | null;
  mentions: TemporalReference[];
  annotations: TemporalReference[];
  loops: Array<{ id: string; title: string; status: OpenLoopState }>;
}

/** Read the current derived references to a capture day's projected document. */
export class NotesProvenanceService {
  constructor(private readonly db: Database.Database) {}

  async forDay(day: string, timeZone = "UTC"): Promise<NotesDayProvenance> {
    const result: NotesDayProvenance = {
      day,
      documentId: null,
      mentions: [],
      annotations: [],
      loops: [],
    };
    const document = this.db
      .prepare<
        [string, string, string],
        { id: string }
      >("SELECT id FROM documents WHERE provider_id = ? AND source_id = ? AND external_id = ?")
      .get(OMNESIS_NOTES_PROVIDER_ID, OMNESIS_NOTES_SOURCE_ID, day);
    if (!document) return result;
    result.documentId = document.id;
    const experimental = experimentalEnabled();
    const temporal = new TemporalQueryService(this.db);
    const bounds = this.db
      .prepare<[string, number, string], { start: number | null; end: number | null }>(
        `SELECT MIN(start_ms) AS start, MAX(end_ms) AS end FROM (
         SELECT unixepoch(mention_start_day) * 1000 AS start_ms,
                unixepoch(mention_end_day) * 1000 AS end_ms
         FROM document_extracted_dates WHERE document_id = ?
         UNION ALL
         SELECT a.interval_start_ms, a.interval_end_ms + 1
         FROM temporal_annotations a JOIN temporal_annotation_documents d ON d.annotation_id = a.id
         WHERE ? = 1 AND d.document_id = ? AND a.invalidated_at IS NULL
       )`,
      )
      .get(document.id, experimental ? 1 : 0, document.id)!;
    let cursor: string | undefined;
    while (bounds.start !== null && bounds.end !== null) {
      // References can name any date, rather than only the day of capture.
      // Stored bounds only establish a window; the shared service owns visibility,
      // deduplication, and the caller's time-zone normalization.
      const page = await temporal.query({
        from: new Date(bounds.start - MAX_TIME_ZONE_SHIFT_MS).toISOString(),
        to: new Date(bounds.end + MAX_TIME_ZONE_SHIFT_MS).toISOString(),
        timeZone,
        documentIds: [document.id],
        sourceIds: [OMNESIS_NOTES_SOURCE_ID],
        origins: experimental ? ["mention", "annotation"] : ["mention"],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) {
        const reference = {
          id: item.id,
          label: item.label,
          start: item.start,
          endExclusive: item.endExclusive,
        };
        if (item.origin === "mention") result.mentions.push(reference);
        else if (item.origin === "annotation") result.annotations.push(reference);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    if (experimental) {
      result.loops = this.db
        .prepare<[string], NotesDayProvenance["loops"][number]>(
          `SELECT l.id, l.title, l.state AS status FROM open_loops l
         JOIN open_loop_docs d ON d.loop_id = l.id
         WHERE d.doc_id = ? ORDER BY l.last_update DESC, l.id`,
        )
        .all(document.id);
    }
    return result;
  }
}
