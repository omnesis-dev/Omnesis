// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Lazy-open helper for the Apple Notes DB. Owns:
 *
 * - Open / close lifecycle, inherited from `SingleFileAppleDb`: a database
 *   that will not open is recorded, and the Notes source raises it as a typed
 *   sync error. Notes is one of seven databases the provider opens in one
 *   pass, and the only source that reads it is Apple Notes — so an unreadable
 *   Notes database is Apple Notes' problem and no one else's.
 * - The PRAGMA-based schema-column probe that picks the live column
 *   names for a given macOS version (Apple renames columns between
 *   macOS releases — `ZTITLE` vs `ZTITLE1` vs `ZTITLE3`, etc.).
 * - A best-effort row count for the post-open log line.
 */

import { release } from "node:os";
import { createLogger } from "@omnesis/core";
import { SingleFileAppleDb } from "./single-file-db.js";
import { fullDiskAccessDenial } from "./internal.js";
import type { NotesSchemaColumns } from "../types.js";

const log = createLogger("provider:apple:notes-db");

export class NotesDbHelper extends SingleFileAppleDb {
  private schemaColumns: NotesSchemaColumns | null = null;
  private unresolvedColumns: string[] = [];

  constructor(path: string) {
    super(path, "Apple Notes", fullDiskAccessDenial(), log);
  }

  override close(): void {
    super.close();
    this.schemaColumns = null;
    this.unresolvedColumns = [];
  }

  /** Best-effort row count — returns 0 on any error. */
  count(): number {
    try {
      const db = this.getDb();
      if (!db) return 0;
      const result = db
        .prepare(
          `SELECT COUNT(*) as count FROM ZICNOTEDATA AS n
           INNER JOIN ZICCLOUDSYNCINGOBJECT AS c ON c.ZNOTEDATA = n.Z_PK
           WHERE c.ZMARKEDFORDELETION != 1 OR c.ZMARKEDFORDELETION IS NULL`,
        )
        .get() as { count: number };
      return result.count;
    } catch {
      return 0;
    }
  }

  /**
   * Detect which column names are used in the Notes DB (varies by
   * macOS version). Each column referenced by `notes.ts` queries is
   * probed against the `ZICCLOUDSYNCINGOBJECT` schema with a small
   * ordered list of candidates. The first candidate that exists wins;
   * the fallback is the un-suffixed historical name. Cached on the
   * helper — one PRAGMA call per process.
   */
  getSchemaColumns(): NotesSchemaColumns {
    if (this.schemaColumns) return this.schemaColumns;

    const db = this.getDb();
    if (!db) throw new Error("Notes database not available");

    const columns = db.prepare("PRAGMA table_info(ZICCLOUDSYNCINGOBJECT)").all() as {
      name: string;
    }[];
    const colNames = new Set(columns.map((c) => c.name));
    const unresolved: string[] = [];
    // A field whose candidates all miss falls back to its historical name. That
    // fallback is a guess, and `ZICCLOUDSYNCINGOBJECT` holds several Core Data
    // entities, so a guessed name can exist and mean something else entirely —
    // in which case the filters built from it quietly select the wrong rows.
    // Record the miss so callers can refuse to draw conclusions from the shape
    // of a read they could not verify.
    const pick = (field: string, candidates: readonly string[]): string => {
      for (const c of candidates) {
        if (colNames.has(c)) return c;
      }
      unresolved.push(field);
      return candidates[candidates.length - 1];
    };

    const cols: NotesSchemaColumns = {
      folderModificationDate: colNames.has("ZFOLDERMODIFICATIONDATE")
        ? "ZFOLDERMODIFICATIONDATE"
        : null,
      creationDate: pick("creationDate", ["ZCREATIONDATE3", "ZCREATIONDATE1", "ZCREATIONDATE"]),
      modificationDate: pick("modificationDate", [
        "ZMODIFICATIONDATE3",
        "ZMODIFICATIONDATE1",
        "ZMODIFICATIONDATE",
      ]),
      title: pick("title", ["ZTITLE1", "ZTITLE3", "ZTITLE"]),
      snippet: pick("snippet", ["ZSNIPPET1", "ZSNIPPET3", "ZSNIPPET"]),
      folderTitle: pick("folderTitle", ["ZTITLE2", "ZTITLE3", "ZTITLE"]),
      account: pick("account", ["ZACCOUNT2", "ZACCOUNT7", "ZACCOUNT4"]),
      isPasswordProtected: pick("isPasswordProtected", [
        "ZISPASSWORDPROTECTED1",
        "ZISPASSWORDPROTECTED",
      ]),
      isPinned: pick("isPinned", ["ZISPINNED1", "ZISPINNED"]),
      markedForDeletion: pick("markedForDeletion", ["ZMARKEDFORDELETION1", "ZMARKEDFORDELETION"]),
    };

    this.schemaColumns = cols;
    this.unresolvedColumns = unresolved;
    if (unresolved.length > 0) {
      log.warn(
        `Notes schema (macOS ${release()}): no known column matched ${unresolved.join(", ")} — ` +
          `every query below is filtering on a guessed column name. Deletion detection is suspended ` +
          `until the provider is taught this schema.`,
      );
    }
    // Promoted to info: the schema-detection result is the single most useful
    // breadcrumb when a macOS upgrade renames a column and ingestion silently
    // returns 0 docs. Logged once per process — `schemaColumns` caches the
    // result, so subsequent calls short-circuit at the top.
    log.info(
      `Notes schema (macOS ${release()}): ${Object.entries(cols)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
    );
    return cols;
  }

  /**
   * Fields whose live column name could not be identified on this macOS
   * version. A non-empty list means the source is reading through at least one
   * guessed column: the rows it selects, and the rows it enumerates for a
   * snapshot, shrink together and stay internally consistent, so nothing about
   * the result looks wrong. Callers must not reconcile deletions against a read
   * of that shape.
   */
  getUnresolvedSchemaColumns(): string[] {
    this.getSchemaColumns();
    return [...this.unresolvedColumns];
  }
}
