// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, computeContentHash } from "@omnesis/core";
import { emptySync, SnapshotEnumeration } from "@omnesis/source-sdk";
import { SourceId, ProviderId, parseSourceId } from "@omnesis/types";
import { validateAppleNotesSyncCursor } from "./types.js";
import { parseNoteBody, coreDataToISO, isoToCoreData } from "./note-parser.js";
import { throwOnOpenFailure } from "./db-helpers/internal.js";
import type { AppleProvider } from "./provider.js";
import type { AppleNotesSyncCursor, RawNote } from "./types.js";
import type { SyncCursor, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, PersonMention, SyncIssue } from "@omnesis/types";

const log = createLogger("source:apple-notes");

const PAGE_SIZE = 100;

/**
 * Apple Notes source.
 * Reads notes from the local NoteStore.sqlite and produces one document per note.
 *
 * Notes.app buffers its own writes: a note deleted in the UI can stay in
 * NoteStore.sqlite for as long as the app is running, and only lands there once
 * it quits. A deletion that this source has not picked up yet is therefore
 * usually a deletion the store has not been told about — the delay is upstream
 * of every read below.
 */
export class AppleNotesSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;

  readonly watchPaths: string[];

  /** Optional ISO 8601 cutoff — notes created before this date are excluded. */
  readonly dataCutoff?: string;

  constructor(
    private provider: AppleProvider,
    opts: { sourceId: string; providerId: string; dataCutoff?: string },
  ) {
    this.id = SourceId(opts.sourceId);
    this.providerId = ProviderId(opts.providerId);
    const dbPath = provider.notesDbFilePath;
    this.watchPaths = [dbPath, `${dbPath}-wal`];
    this.dataCutoff = opts.dataCutoff;
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    const db = this.provider.getNotesDb();
    if (!db) {
      // A database that exists but will not open is this source's failure to
      // report — a denial the operator can act on, or a lock worth another
      // cycle. Only a Mac with no Notes database at all syncs nothing quietly.
      throwOnOpenFailure(this.provider.getNotesOpenFailure());
      return emptySync(cursor ?? { lastModifiedTimestamp: 0 });
    }

    // Every query below is built from column names probed off the live schema.
    // A field whose candidates all miss falls back to a guess, and a guessed
    // column that does not exist turns each query into an opaque "no such
    // column" from deep inside the walk. Fail here instead, naming the fields,
    // so the operator sees which macOS release the provider has not been taught.
    const unresolvedColumns = this.provider.getNotesUnresolvedSchemaColumns();
    if (unresolvedColumns.length > 0) {
      throw new Error(
        `Apple Notes schema not recognised on this macOS version — no known column matched ` +
          `${unresolvedColumns.join(", ")}. Refusing to read rather than filter on a guess.`,
      );
    }

    const state = validateAppleNotesSyncCursor(cursor);
    const lastModified = state?.lastModifiedTimestamp ?? 0;
    // Tie-breaker half of the composite `(modificationDate, Z_PK)` cursor.
    // Defaults to 0 so a legacy timestamp-only cursor (or a fresh bootstrap)
    // matches every note tied to `lastModified` via `Z_PK > 0`.
    const lastPk = state?.lastModifiedPk ?? 0;

    const cols = this.provider.getNotesSchemaColumns();

    // Convert dataCutoff to Core Data timestamp for SQL filtering
    const cutoffTimestamp = this.dataCutoff ? isoToCoreData(this.dataCutoff) : null;

    // Queue size for this cycle = rows we'll process now (modificationDate
    // > cursor). Counted once on the first page and pinned in the cursor
    // for subsequent pages so the progress bar's `total` stays stable.
    // Bootstrap (cursor=0) ⇒ queue = all non-deleted notes; incremental ⇒
    // queue = just the rows changed since the last cycle. A sync is a sync.
    let totalNotes: number | undefined = state?.cycleQueueTotal;
    if (totalNotes === undefined) {
      const countParams: number[] = [lastModified, lastModified, lastPk];
      let countCutoffClause = "";
      if (cutoffTimestamp !== null) {
        countCutoffClause = ` AND c.${cols.creationDate} >= ?`;
        countParams.push(cutoffTimestamp);
      }
      const totalResult = db
        .prepare(
          `SELECT COUNT(*) as count FROM ZICNOTEDATA AS n
           INNER JOIN ZICCLOUDSYNCINGOBJECT AS c ON c.ZNOTEDATA = n.Z_PK
           LEFT JOIN ZICCLOUDSYNCINGOBJECT AS c2 ON c2.Z_PK = c.ZFOLDER
           WHERE (c.${cols.markedForDeletion} != 1 OR c.${cols.markedForDeletion} IS NULL)
             AND (c2.ZIDENTIFIER NOT LIKE 'Trash%' OR c2.ZIDENTIFIER IS NULL)
             AND (c.${cols.isPasswordProtected} != 1 OR c.${cols.isPasswordProtected} IS NULL)
             AND (c.${cols.modificationDate} > ?
                  OR (c.${cols.modificationDate} = ? AND c.Z_PK > ?))${countCutoffClause}`,
        )
        .get(...countParams) as { count: number };
      totalNotes = totalResult.count;
    }

    // Fetch notes modified since last cursor, ordered by modification date.
    // Known gap: #79 — a note restored from "Recently Deleted" bumps only
    // the folder-move stamp, so this window misses it until its next edit.
    // Excludes permanently deleted notes (ZMARKEDFORDELETION=1) and notes
    // moved to the "Recently Deleted" folder (folder ZIDENTIFIER starts with
    // 'Trash').
    //
    // Locked notes are excluded too: their body is opaquely encrypted, so
    // indexing them would put a placeholder string in the corpus that every
    // locked note matches. The snapshot enumeration below applies the identical
    // `isPasswordProtected` filter, so a locked note is absent from both the
    // ingest and the snapshot — never present in one and missing from the
    // other, which is what would make it look deleted.
    const dataCutoffClause = cutoffTimestamp !== null ? `AND c.${cols.creationDate} >= ?` : "";
    const query = `
      SELECT
        c.Z_PK as pk,
        c.${cols.title} as title,
        c.${cols.snippet} as snippet,
        c.ZIDENTIFIER as identifier,
        c.${cols.creationDate} as creationDate,
        c.${cols.modificationDate} as modificationDate,
        c.${cols.isPasswordProtected} as isLocked,
        c.${cols.isPinned} as isPinned,
        c.${cols.markedForDeletion} as isTrashed,
        c2.${cols.folderTitle} as folderName,
        c2.ZIDENTIFIER as folderIdentifier,
        c5.ZNAME as accountName,
        n.ZDATA as data
      FROM ZICNOTEDATA AS n
      INNER JOIN ZICCLOUDSYNCINGOBJECT AS c ON c.ZNOTEDATA = n.Z_PK
      LEFT JOIN ZICCLOUDSYNCINGOBJECT AS c2 ON c2.Z_PK = c.ZFOLDER
      LEFT JOIN ZICCLOUDSYNCINGOBJECT AS c5 ON c5.Z_PK = c.${cols.account}
      WHERE (c.${cols.modificationDate} > ?
             OR (c.${cols.modificationDate} = ? AND c.Z_PK > ?))
        AND (c.${cols.markedForDeletion} != 1 OR c.${cols.markedForDeletion} IS NULL)
        AND (c2.ZIDENTIFIER NOT LIKE 'Trash%' OR c2.ZIDENTIFIER IS NULL)
        AND (c.${cols.isPasswordProtected} != 1 OR c.${cols.isPasswordProtected} IS NULL)
        ${dataCutoffClause}
      ORDER BY c.${cols.modificationDate} ASC, c.Z_PK ASC
      LIMIT ?
    `;

    const queryParams: number[] = [lastModified, lastModified, lastPk];
    if (cutoffTimestamp !== null) {
      queryParams.push(cutoffTimestamp);
    }
    queryParams.push(PAGE_SIZE + 1);

    const rows = db.prepare(query).all(...queryParams) as RawNote[];

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    // Find deleted notes: either permanently deleted (ZMARKEDFORDELETION=1)
    // or moved to the "Recently Deleted" folder. The window is the same
    // composite `(modificationDate, Z_PK)` boundary the live query uses, and
    // the cursor advances past every deletion it reports, so each deletion is
    // reported exactly once — a replicated source reads every tombstone as
    // this member asserting the deletion.
    //
    // A deletion initiated on another device moves the note to the trash
    // WITHOUT bumping its modification date — only the folder-modification
    // timestamp records the move, and a cursor already past the note's last
    // edit would never see it. The window therefore keys each trashed note on
    // the greater of the two timestamps (where the store has the column), and
    // that same value is what the cursor advances past below.
    //
    // Skip on bootstrap (`lastModified === 0`): with no cursor, the window
    // holds every trashed note and would emit them as fake deletes even
    // though the gateway has nothing to delete on a first sync. The snapshot
    // reconciliation path (`presentExternalIds`) handles real delete
    // detection on the final page; per-cycle `deletedExternalIds` is only
    // useful as an *incremental* fast-path.
    const deletionStamp = cols.folderModificationDate
      ? `MAX(COALESCE(c.${cols.modificationDate}, 0), COALESCE(c.${cols.folderModificationDate}, 0))`
      : `c.${cols.modificationDate}`;
    const deletedRows =
      lastModified === 0
        ? []
        : (db
            .prepare(
              `SELECT c.Z_PK as pk, c.ZIDENTIFIER as identifier, ${deletionStamp} as modificationDate
             FROM ZICCLOUDSYNCINGOBJECT AS c
             INNER JOIN ZICNOTEDATA AS n ON c.ZNOTEDATA = n.Z_PK
             LEFT JOIN ZICCLOUDSYNCINGOBJECT AS c2 ON c2.Z_PK = c.ZFOLDER
             WHERE (c.${cols.markedForDeletion} = 1 OR c2.ZIDENTIFIER LIKE 'Trash%')
               AND (${deletionStamp} > ?
                    OR (${deletionStamp} = ? AND c.Z_PK > ?))`,
            )
            .all(lastModified, lastModified, lastPk) as {
            pk: number;
            identifier: string;
            modificationDate: number;
          }[]);

    // Debug: show what the DB max looks like vs our cursor
    if (lastModified > 0) {
      const maxInDb = db
        .prepare(
          `SELECT MAX(c.${cols.modificationDate}) as maxMod
           FROM ZICCLOUDSYNCINGOBJECT AS c
           INNER JOIN ZICNOTEDATA AS n ON c.ZNOTEDATA = n.Z_PK`,
        )
        .get() as { maxMod: number | null };
      log.debug(
        `Incremental query: cursor=${lastModified}, dbMax=${maxInDb?.maxMod}, found=${rows.length} docs, ${deletedRows.length} deletes`,
      );
    }

    const documents: DocumentInput[] = [];
    // Composite cursor advances to the `(modificationDate, Z_PK)` of the last
    // row on the page. `pageRows` is already sorted `(modificationDate ASC,
    // Z_PK ASC)` by the query, so its final element is the boundary — every
    // earlier row, including locked notes skipped below, sits before it and is
    // covered. Empty page leaves the cursor where it was.
    let maxModified = lastModified;
    let maxPk = lastPk;
    if (pageRows.length > 0) {
      const boundary = pageRows[pageRows.length - 1];
      maxModified = boundary.modificationDate;
      maxPk = boundary.pk;
    }

    // Pattern A: stamp the source's account email as document author. Resolves to
    // self via the existing alias graph because the email is already a self-alias
    // (set up via Apple Contacts isMe=true card). Per-note creator extraction
    // (family-shared notes from another user) is tracked in #25.
    const { accountId } = parseSourceId(this.id);
    const authorPeople: PersonMention[] | undefined = accountId.includes("@")
      ? [{ role: "author", emails: [accountId], phones: [] }]
      : undefined;

    for (const row of pageRows) {
      // Parse note body
      let content = "";
      if (row.data) {
        content = parseNoteBody(row.data as unknown as Buffer);
      } else if (row.snippet) {
        content = row.snippet;
      }

      const title = row.title || "Untitled Note";

      const doc: DocumentInput = {
        providerId: this.providerId,
        sourceId: this.id,
        externalId: row.identifier,
        title,
        content,
        contentHash: computeContentHash(content),
        metadata: {
          sourceUrl: `notes://showNote?identifier=${row.identifier}`,
          appUrl: `mobilenotes://showNote?identifier=${row.identifier}`,
          documentType: "note",
          tags: row.folderName ? [row.folderName] : undefined,
          people: authorPeople,
          extra: {
            folder: row.folderName ?? undefined,
            account: row.accountName ?? undefined,
            isLocked: !!row.isLocked,
            isPinned: !!row.isPinned,
          },
        },
        sourceCreatedAt: row.creationDate
          ? coreDataToISO(row.creationDate)
          : coreDataToISO(row.modificationDate),
        sourceUpdatedAt: coreDataToISO(row.modificationDate),
      };

      documents.push(doc);
    }

    // While more live rows remain, only the deletions inside this page's
    // window are reported: a deletion beyond the page boundary belongs to the
    // page whose cursor advance covers it, and reporting it now would repeat
    // it there.
    const reportedDeletes = hasMore
      ? deletedRows.filter(
          (row) =>
            row.modificationDate < maxModified ||
            (row.modificationDate === maxModified && row.pk <= maxPk),
        )
      : deletedRows;
    const deletedExternalIds = reportedDeletes.map((r) => r.identifier);

    // Advance the cursor past deleted notes too, but only once the page is
    // drained (`!hasMore`). While more live rows remain, the page boundary
    // `(maxModified, maxPk)` is the furthest we may safely advance — a delete
    // at a higher timestamp would leap the cursor over live notes not yet
    // paged in. Once drained, every live row up to now has been paged, so the
    // cursor may move to the greatest `(modificationDate, Z_PK)` among the
    // deletes and the next cycle's window starts strictly after them.
    if (!hasMore) {
      for (const row of deletedRows) {
        if (
          row.modificationDate > maxModified ||
          (row.modificationDate === maxModified && row.pk > maxPk)
        ) {
          maxModified = row.modificationDate;
          maxPk = row.pk;
        }
      }
    }

    const isBootstrap = lastModified === 0;

    // Snapshot reconciliation: emit `presentExternalIds` only on the
    // FINAL page of a sync run (`!hasMore`). Mid-bootstrap emission
    // would tell the gateway to delete every note we haven't paged
    // through yet — the spurious-deletions bug from the QA pass.
    // The gate also covers incremental no-op cycles: a mid-bootstrap
    // run never reaches `!hasMore`, so the snapshot waits until the
    // bootstrap is fully drained.
    let presentExternalIds: string[] | undefined;
    let issues: SyncIssue[] | undefined;
    let snapshotSignature = state?.lastSnapshotSignature;
    if (!hasMore) {
      // One partition — the note store. The claim the snapshot carries is only
      // as good as the column names the queries are built from: when a macOS
      // release renames a column to something the provider does not know but
      // whose historical name still exists under another Core Data entity, the
      // page query and the enumeration below filter on the same wrong column
      // and shrink together. Nothing in the result looks wrong, which is why
      // the enumeration is measured against the last snapshot the source
      // vouched for rather than believed on its own.
      const snapshot = new SnapshotEnumeration(["notes"]);
      const enumParams: number[] = [];
      let enumCutoffClause = "";
      if (cutoffTimestamp !== null) {
        enumCutoffClause = ` AND c.${cols.creationDate} >= ?`;
        enumParams.push(cutoffTimestamp);
      }
      // Cheap signature scan first — a handful of aggregates over the same
      // WHERE filter as the enum, in one pass. When the signature matches the
      // previous cycle the snapshot is unchanged and we skip the full ID
      // enumeration (a multi-table join + JS array build over every note).
      //
      // Each term catches a change class the others miss: `cnt` (adds and
      // removes), `maxMod` (ordinary edits), `maxPk` (an equal-count exchange
      // — a note leaving the live set while another joins it, e.g. a restore
      // from iCloud; Core Data primary keys are monotone, so a joining row
      // always raises the maximum), and `sumMod` (an edit stamped with a
      // timestamp that trails the watermark). A signature stored under a
      // different term count can never compare equal to one of this shape, so
      // a cursor written before a term was added re-enumerates once.
      const sig = db
        .prepare(
          `SELECT COUNT(*) as cnt, COALESCE(MAX(c.${cols.modificationDate}), 0) as maxMod,
                  COALESCE(MAX(c.Z_PK), 0) as maxPk,
                  CAST(ROUND(COALESCE(TOTAL(c.${cols.modificationDate}), 0)) AS INTEGER) as sumMod
           FROM ZICNOTEDATA AS n
           INNER JOIN ZICCLOUDSYNCINGOBJECT AS c ON c.ZNOTEDATA = n.Z_PK
           LEFT JOIN ZICCLOUDSYNCINGOBJECT AS c2 ON c2.Z_PK = c.ZFOLDER
           WHERE (c.${cols.markedForDeletion} != 1 OR c.${cols.markedForDeletion} IS NULL)
             AND (c2.ZIDENTIFIER NOT LIKE 'Trash%' OR c2.ZIDENTIFIER IS NULL)
             AND (c.${cols.isPasswordProtected} != 1 OR c.${cols.isPasswordProtected} IS NULL)${enumCutoffClause}`,
        )
        .get(...enumParams) as { cnt: number; maxMod: number; maxPk: number; sumMod: number };
      const newSignature = `${sig.cnt}:${sig.maxMod}:${sig.maxPk}:${sig.sumMod}`;
      if (newSignature !== state?.lastSnapshotSignature) {
        const enumRows = db
          .prepare(
            `SELECT c.ZIDENTIFIER as identifier
             FROM ZICNOTEDATA AS n
             INNER JOIN ZICCLOUDSYNCINGOBJECT AS c ON c.ZNOTEDATA = n.Z_PK
             LEFT JOIN ZICCLOUDSYNCINGOBJECT AS c2 ON c2.Z_PK = c.ZFOLDER
             WHERE (c.${cols.markedForDeletion} != 1 OR c.${cols.markedForDeletion} IS NULL)
               AND (c2.ZIDENTIFIER NOT LIKE 'Trash%' OR c2.ZIDENTIFIER IS NULL)
               AND (c.${cols.isPasswordProtected} != 1 OR c.${cols.isPasswordProtected} IS NULL)${enumCutoffClause}`,
          )
          .all(...enumParams) as { identifier: string }[];
        snapshot.cover(
          "notes",
          enumRows.map((r) => r.identifier),
        );
        presentExternalIds = snapshot.result();
        const issue = snapshot.withheldIssue();
        issues = issue ? [issue] : [];
        if (presentExternalIds === undefined) {
          log.warn(snapshot.withheldReason()!);
        } else {
          // Only a cycle that emitted advances the signature, so a withheld one
          // still compares against the last snapshot actually published.
          snapshotSignature = newSignature;
        }
      }
    }

    log.info(
      `Sync produced ${documents.length} docs, -${deletedExternalIds.length} (${isBootstrap ? "bootstrap" : "incremental"}, hasMore: ${hasMore}, snapshot: ${presentExternalIds?.length ?? "unchanged"})`,
    );

    return {
      documents,
      deletedExternalIds,
      presentExternalIds,
      issues,
      cursor: {
        lastModifiedTimestamp: maxModified,
        lastModifiedPk: maxPk,
        cycleQueueTotal: hasMore ? totalNotes : undefined,
        lastSnapshotSignature: snapshotSignature,
      } satisfies AppleNotesSyncCursor,
      hasMore,
      progress:
        totalNotes > 0
          ? {
              phase: isBootstrap ? "bootstrap" : "incremental",
              processed: documents.length,
              total: totalNotes,
            }
          : undefined,
    };
  }
}
