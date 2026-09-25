// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import type { SyncCursor, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import { createLogger, computeContentHash } from "@omnesis/core";
import { SourceId, ProviderId, parseSourceId } from "@omnesis/types";
import type { AppleRemindersSyncCursor, RawReminder } from "./types.js";
import { validateAppleRemindersSyncCursor } from "./types.js";
import { coreDataToISO, isoToCoreData } from "./note-parser.js";
import { release } from "node:os";

const log = createLogger("source:apple-reminders");

const PAGE_SIZE = 200;

const PRIORITY_LABELS: Record<number, string> = {
  1: "high",
  5: "medium",
  9: "low",
};

/**
 * Deep link that opens one reminder in Reminders on macOS and iOS. The
 * scheme addresses a reminder by its dashed UUID; `ZIDENTIFIER` is that
 * UUID's 16 raw bytes, read here as 32 hex characters. Any other shape
 * gets no link rather than one that opens the wrong place.
 */
function reminderUrl(identifierHex: string): string | undefined {
  const h = identifierHex.toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(h)) return undefined;
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return `x-apple-reminderkit://REMCDReminder/${uuid}`;
}

/**
 * Apple Reminders source.
 * Reads reminders from a single Reminders SQLite store.
 * One source instance per store (per iCloud account).
 */
export class AppleRemindersSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;
  readonly watchPaths: string[];

  /** Optional ISO 8601 cutoff — reminders created before this date are excluded. */
  readonly dataCutoff?: string;

  /**
   * Pattern A: stamp the source's account email as document author. Resolves to
   * self via the existing alias graph. Per-reminder creator extraction for
   * shared lists from other users is tracked in #281.
   */
  private readonly accountPeople: { role: "author"; emails: [string] }[] | undefined;

  /**
   * Hashtag schema cache. macOS versions vary on whether the hashtag tables
   * exist and which `ZREMINDER*` column on `ZREMCDOBJECT` carries the FK
   * (`ZREMINDER`, `ZREMINDER1`, `ZREMINDER3`, …). Detected once at first sync.
   */
  private hashtagSchema: { fkColumn: string } | null | undefined = undefined;

  constructor(
    private db: Db,
    opts: { sourceId: string; providerId: string; dbPath: string; dataCutoff?: string },
  ) {
    this.id = SourceId(opts.sourceId);
    this.providerId = ProviderId(opts.providerId);
    this.watchPaths = [opts.dbPath, `${opts.dbPath}-wal`];
    this.dataCutoff = opts.dataCutoff;

    const { accountId } = parseSourceId(this.id);
    this.accountPeople = accountId.includes("@")
      ? [{ role: "author", emails: [accountId] }]
      : undefined;
  }

  /**
   * Resolve and cache the hashtag schema (table existence + FK column name).
   * Returns null if the schema is missing — older macOS versions ship without
   * `ZREMCDHASHTAGLABEL` and we silently degrade to "no hashtags".
   *
   * `ZREMCDOBJECT` may expose 6+ ZREMINDER\d* columns (one per Core Data
   * relationship). Only one of them carries the hashtag FK on a given macOS
   * schema (observed: `ZREMINDER3` on Sequoia). We pick the right one by
   * probing each candidate and counting rows where `<col> IS NOT NULL AND
   * ZHASHTAGLABEL IS NOT NULL` — the column with the highest count wins.
   * If no candidate has any hashtag-bearing rows we don't cache, so the next
   * sync re-probes and picks up the user's first inline hashtag.
   */
  private getHashtagSchema(): { fkColumn: string } | null {
    if (this.hashtagSchema !== undefined) return this.hashtagSchema;

    const tables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ZREMCDHASHTAGLABEL','ZREMCDOBJECT')",
      )
      .all() as { name: string }[];
    if (tables.length < 2) {
      this.hashtagSchema = null;
      log.info(
        `Reminders hashtag schema (macOS ${release()}): no ZREMCDHASHTAGLABEL/ZREMCDOBJECT tables — hashtags disabled`,
      );
      return null;
    }

    const cols = this.db.prepare("PRAGMA table_info(ZREMCDOBJECT)").all() as { name: string }[];
    const candidates = cols.map((c) => c.name).filter((name) => /^ZREMINDER\d*$/.test(name));
    if (candidates.length === 0) {
      this.hashtagSchema = null;
      log.info(
        `Reminders hashtag schema (macOS ${release()}): no ZREMINDER* candidate columns on ZREMCDOBJECT — hashtags disabled`,
      );
      return null;
    }

    let bestColumn: string | null = null;
    let bestCount = 0;
    for (const col of candidates) {
      try {
        const row = this.db
          .prepare(
            `SELECT COUNT(*) as n FROM ZREMCDOBJECT WHERE ${col} IS NOT NULL AND ZHASHTAGLABEL IS NOT NULL`,
          )
          .get() as { n: number };
        if (row.n > bestCount) {
          bestCount = row.n;
          bestColumn = col;
        }
      } catch {
        /* column doesn't exist or schema mismatch — skip */
      }
    }

    if (bestColumn !== null) {
      this.hashtagSchema = { fkColumn: bestColumn };
      log.info(
        `Reminders hashtag schema (macOS ${release()}): fkColumn=${bestColumn} (rows=${bestCount}, candidates=[${candidates.join(",")}])`,
      );
      return this.hashtagSchema;
    }

    // No hashtag-bearing rows exist yet on any candidate column. Don't cache —
    // the user may be about to create their first hashtag, and re-probing
    // each sync (~5 min cycle) is cheap.
    return null;
  }

  /**
   * Bulk-fetch hashtags for a page of reminders, grouped by reminder PK.
   * Returns an empty Map on schema-absent or query failure.
   */
  private fetchHashtagsByReminder(reminderPks: number[]): Map<number, string[]> {
    const empty = new Map<number, string[]>();
    if (reminderPks.length === 0) return empty;
    const schema = this.getHashtagSchema();
    if (!schema) return empty;

    try {
      const placeholders = reminderPks.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT o.${schema.fkColumn} as pk, h.ZNAME as name
           FROM ZREMCDOBJECT o
           JOIN ZREMCDHASHTAGLABEL h ON h.Z_PK = o.ZHASHTAGLABEL
           WHERE o.${schema.fkColumn} IN (${placeholders}) AND h.ZNAME IS NOT NULL`,
        )
        .all(...reminderPks) as { pk: number; name: string }[];

      const result = new Map<number, string[]>();
      for (const row of rows) {
        const list = result.get(row.pk) ?? [];
        list.push(row.name);
        result.set(row.pk, list);
      }
      return result;
    } catch (err) {
      log.debug(
        `Hashtag fetch failed (schema mismatch?): ${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    }
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    const state = validateAppleRemindersSyncCursor(cursor);
    const lastModified = state?.lastModifiedTimestamp ?? 0;
    const lastModifiedPk = state?.lastModifiedPk ?? 0;

    const allDocuments: DocumentInput[] = [];
    const allDeletedIds: string[] = [];
    let maxModified = lastModified;
    let maxModifiedPk = lastModifiedPk;
    let hasMore = false;

    // Convert dataCutoff to Core Data timestamp for SQL filtering
    const cutoffTimestamp = this.dataCutoff ? isoToCoreData(this.dataCutoff) : null;
    const cutoffClause = cutoffTimestamp !== null ? " AND r.ZCREATIONDATE >= ?" : "";

    // Queue size for this cycle: rows we'll process now
    // (lastModifiedDate > cursor). Counted once on the first page and
    // pinned in the cursor so the progress bar's `total` stays stable
    // across pages. Bootstrap and incremental share the same model.
    let totalReminders: number | undefined = state?.cycleQueueTotal;
    if (totalReminders === undefined) {
      const countParams: number[] = [lastModified, lastModified, lastModifiedPk];
      if (cutoffTimestamp !== null) countParams.push(cutoffTimestamp);
      const countRow = this.db
        .prepare(
          `SELECT COUNT(*) as count FROM ZREMCDREMINDER
           WHERE (ZMARKEDFORDELETION != 1 OR ZMARKEDFORDELETION IS NULL)
             AND (ZLASTMODIFIEDDATE > ? OR (ZLASTMODIFIEDDATE = ? AND Z_PK > ?))${cutoffClause.replace("r.", "")}`,
        )
        .get(...countParams) as { count: number };
      totalReminders = countRow.count;
    }

    // Fetch reminders modified since cursor. Keyset pagination over the
    // composite key `(ZLASTMODIFIEDDATE, Z_PK)`: a plain `ZLASTMODIFIEDDATE >
    // ?` walk drops reminders that share an identical `ZLASTMODIFIEDDATE` at a
    // page boundary (more than PAGE_SIZE tied rows — e.g. a bulk list import),
    // because page 1 slices them off and page 2's `> timestamp` excludes the
    // tied value. The PK tiebreaker resumes mid-run instead.
    const queryParams: number[] = [lastModified, lastModified, lastModifiedPk];
    if (cutoffTimestamp !== null) queryParams.push(cutoffTimestamp);
    queryParams.push(PAGE_SIZE + 1);
    const rows = this.db
      .prepare(
        `SELECT
           r.Z_PK as pk,
           hex(r.ZIDENTIFIER) as identifier,
           r.ZTITLE as title,
           r.ZNOTES as notes,
           r.ZCOMPLETED as completed,
           r.ZFLAGGED as flagged,
           r.ZPRIORITY as priority,
           r.ZCREATIONDATE as creationDate,
           r.ZLASTMODIFIEDDATE as lastModifiedDate,
           r.ZDUEDATE as dueDate,
           r.ZCOMPLETIONDATE as completionDate,
           r.ZALLDAY as allDay,
           r.ZMARKEDFORDELETION as markedForDeletion,
           l.ZNAME as listName
         FROM ZREMCDREMINDER r
         LEFT JOIN ZREMCDBASELIST l ON l.Z_PK = r.ZLIST
         WHERE (r.ZLASTMODIFIEDDATE > ? OR (r.ZLASTMODIFIEDDATE = ? AND r.Z_PK > ?))
           AND (r.ZMARKEDFORDELETION != 1 OR r.ZMARKEDFORDELETION IS NULL)${cutoffClause}
         ORDER BY r.ZLASTMODIFIEDDATE ASC, r.Z_PK ASC
         LIMIT ?`,
      )
      .all(...queryParams) as RawReminder[];

    if (rows.length > PAGE_SIZE) {
      hasMore = true;
    }
    const pageRows = rows.length > PAGE_SIZE ? rows.slice(0, PAGE_SIZE) : rows;

    // One bulk lookup per page beats N+1 per-reminder queries; map keyed by
    // reminder Z_PK so reminderToDocument can splice tags in.
    const hashtagsByPk = this.fetchHashtagsByReminder(pageRows.map((r) => r.pk));

    for (const row of pageRows) {
      const doc = this.reminderToDocument(row, hashtagsByPk.get(row.pk) ?? []);
      allDocuments.push(doc);
    }

    // Keyset frontier = the last emitted page row in `(ZLASTMODIFIEDDATE, Z_PK)`
    // order. The next page resumes from exactly this position, so tied rows
    // past the slice are picked up rather than skipped.
    if (pageRows.length > 0) {
      const lastRow = pageRows[pageRows.length - 1];
      maxModified = lastRow.lastModifiedDate;
      maxModifiedPk = lastRow.pk;
    }

    // Find deleted reminders. Aligned with the Notes contract:
    //
    // - Use `>= cursor` to cover the boundary — `>` lost an entry that
    //   matched the cursor exactly (rare but real on a same-millisecond
    //   modification).
    // - Skip on bootstrap (`lastModified === 0`): with no cursor every
    //   trashed reminder matches and gets emitted as a fake delete even
    //   though the gateway has nothing to remove. The snapshot reconcile
    //   path (when wired up) handles real delete
    //   detection on the final page.
    // - Advance `maxModified` past every deleted row's timestamp so the
    //   cursor stays monotonic over (changes ∪ deletions). Without this,
    //   a delete-only cycle never advanced the cursor and the same row
    //   re-emitted every cycle until a subsequent change bumped it. Only
    //   apply this on the final page (`!hasMore`): while more present pages
    //   remain, the cursor must stay pinned to the keyset frontier, or a
    //   deletion at a higher timestamp would skip not-yet-paged present rows.
    const deletedRows =
      lastModified === 0
        ? []
        : (this.db
            .prepare(
              `SELECT hex(ZIDENTIFIER) as identifier, ZLASTMODIFIEDDATE as modificationDate
             FROM ZREMCDREMINDER
             WHERE ZMARKEDFORDELETION = 1
               AND ZLASTMODIFIEDDATE >= ?`,
            )
            .all(lastModified) as { identifier: string; modificationDate: number }[]);

    for (const r of deletedRows) {
      allDeletedIds.push(r.identifier);
      if (!hasMore && r.modificationDate > maxModified) {
        // The watermark now sits at a deletion-only timestamp past every
        // present row we emitted, so the PK tiebreaker no longer refers to a
        // consumed reminder — reset it so the next cycle starts at the first
        // PK of that timestamp rather than skipping tied present rows.
        maxModified = r.modificationDate;
        maxModifiedPk = 0;
      }
    }

    const isBootstrap = lastModified === 0;

    log.info(
      `Sync produced ${allDocuments.length} docs, -${allDeletedIds.length} (${isBootstrap ? "bootstrap" : "incremental"}, hasMore: ${hasMore})`,
    );

    return {
      documents: allDocuments,
      deletedExternalIds: allDeletedIds,
      cursor: {
        lastModifiedTimestamp: maxModified,
        lastModifiedPk: maxModifiedPk,
        cycleQueueTotal: hasMore ? totalReminders : undefined,
      } satisfies AppleRemindersSyncCursor,
      hasMore,
      progress:
        totalReminders > 0
          ? {
              phase: isBootstrap ? "bootstrap" : "incremental",
              processed: allDocuments.length,
              total: totalReminders,
            }
          : undefined,
    };
  }

  private reminderToDocument(row: RawReminder, hashtags: string[]): DocumentInput {
    const title = row.title || "Untitled Reminder";

    // Normalise hashtags: lowercase, strip leading '#', dedupe.
    const normalizedHashtags = Array.from(
      new Set(
        hashtags.map((t) => t.replace(/^#+/, "").trim().toLowerCase()).filter((t) => t.length > 0),
      ),
    );

    // Build content
    const lines: string[] = [];
    lines.push(`# ${title}`);

    if (row.notes) {
      lines.push("", row.notes);
    }

    if (normalizedHashtags.length > 0) {
      // Render with leading '#' so search hits like `#news` BM25-match the body.
      lines.push("", `Tags: ${normalizedHashtags.map((t) => `#${t}`).join(" ")}`);
    }

    // First-class typed deadline, promoted from the reminder's due date. A
    // reminder has only a hard due date (no separate scheduled-start), so it
    // fills the generic `dueAt` and leaves `scheduledAt` unset. All-day
    // reminders keep the date-only ISO form (no timezone); the same value is
    // rendered into the prose below.
    const dueAt = row.dueDate
      ? row.allDay
        ? coreDataToISO(row.dueDate).split("T")[0]
        : coreDataToISO(row.dueDate)
      : undefined;

    const details: string[] = [];
    if (row.completed) {
      details.push(
        `Status: Completed${row.completionDate ? ` (${coreDataToISO(row.completionDate).split("T")[0]})` : ""}`,
      );
    }
    if (dueAt) {
      details.push(`Due: ${dueAt}`);
    }
    if (row.priority > 0) {
      details.push(`Priority: ${PRIORITY_LABELS[row.priority] ?? String(row.priority)}`);
    }
    if (row.flagged) {
      details.push("Flagged");
    }
    if (row.listName) {
      details.push(`List: ${row.listName}`);
    }

    if (details.length > 0) {
      lines.push("", details.join(" | "));
    }

    const content = lines.join("\n");

    // Combine list name + hashtags into the tags array; deduped, list name
    // first so the existing list-name-as-tag UX is preserved.
    const allTags: string[] = [];
    if (row.listName) allTags.push(row.listName);
    for (const tag of normalizedHashtags) {
      if (!allTags.includes(tag)) allTags.push(tag);
    }

    return {
      providerId: this.providerId,
      sourceId: this.id,
      externalId: row.identifier,
      title,
      content,
      contentHash: computeContentHash(content),
      metadata: {
        sourceUrl: reminderUrl(row.identifier),
        documentType: "reminder",
        dueAt,
        status: row.completed ? "completed" : "open",
        tags: allTags.length > 0 ? allTags : undefined,
        people: this.accountPeople,
        extra: {
          list: row.listName ?? undefined,
          hashtags: normalizedHashtags.length > 0 ? normalizedHashtags : undefined,
          completed: !!row.completed,
          flagged: !!row.flagged,
          priority:
            PRIORITY_LABELS[row.priority] ?? (row.priority > 0 ? String(row.priority) : undefined),
          dueDate: row.dueDate ? coreDataToISO(row.dueDate) : undefined,
          completionDate: row.completionDate ? coreDataToISO(row.completionDate) : undefined,
        },
      },
      sourceCreatedAt: coreDataToISO(row.creationDate),
      sourceUpdatedAt: coreDataToISO(row.lastModifiedDate),
    };
  }
}
