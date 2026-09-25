// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";

export interface CorpusDoc {
  id: string;
  providerId: string;
  sourceId: string;
  title: string;
  content: string;
  contentHash: string;
  docType: string;
  sourceCreatedAt: number | null;
}

export interface CorpusReaderOptions {
  includeTypes: ReadonlySet<string>;
  minContentLength?: number;
  maxContentLength?: number;
}

const DEFAULT_INCLUDE_TYPES: ReadonlySet<string> = new Set([
  "email",
  "note",
  "document",
  "attachment",
  "webpage",
  "file",
]);

export class CorpusReader {
  readonly db: Database.Database;
  private readonly opts: Required<CorpusReaderOptions>;

  constructor(dbPath: string, opts?: Partial<CorpusReaderOptions>) {
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.opts = {
      includeTypes: opts?.includeTypes ?? DEFAULT_INCLUDE_TYPES,
      minContentLength: opts?.minContentLength ?? 80,
      maxContentLength: opts?.maxContentLength ?? 2_000_000,
    };
  }

  close(): void {
    this.db.close();
  }

  countTotal(): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM documents WHERE LENGTH(content) >= ?`)
      .get(this.opts.minContentLength) as { n: number };
    return r.n;
  }

  /**
   * Stream documents in stable order (by id). Filters by content length
   * bounds and by parsed `metadata.documentType` against the include set.
   * Documents with no documentType metadata fall through to the catch-all
   * "document" bucket if that is in the include set.
   */
  *stream(): Iterable<CorpusDoc> {
    const stmt = this.db.prepare(`
      SELECT id, provider_id, source_id, title, content, content_hash, metadata,
             source_created_at
      FROM documents
      WHERE LENGTH(content) BETWEEN ? AND ?
      ORDER BY id
    `);
    const rows = stmt.iterate(this.opts.minContentLength, this.opts.maxContentLength) as Iterable<{
      id: string;
      provider_id: string;
      source_id: string;
      title: string;
      content: string;
      content_hash: string;
      metadata: string;
      source_created_at: string;
    }>;
    for (const row of rows) {
      const docType = extractDocType(row.metadata);
      if (!this.opts.includeTypes.has(docType)) continue;
      yield {
        id: row.id,
        providerId: row.provider_id,
        sourceId: row.source_id,
        title: row.title,
        content: row.content,
        contentHash: row.content_hash,
        docType,
        sourceCreatedAt: parseIsoToEpoch(row.source_created_at),
      };
    }
  }

  /**
   * Look up content for a candidate document by id (used during pair
   * verification — we re-shingle on demand rather than storing shingle
   * sets in the side DB).
   */
  getContent(id: string): { content: string; title: string; docType: string } | null {
    const r = this.db
      .prepare(`SELECT title, content, metadata FROM documents WHERE id = ?`)
      .get(id) as { title: string; content: string; metadata: string } | undefined;
    if (!r) return null;
    return {
      content: r.content,
      title: r.title,
      docType: extractDocType(r.metadata),
    };
  }
}

function extractDocType(metadataJson: string): string {
  try {
    const m = JSON.parse(metadataJson) as { documentType?: unknown };
    if (typeof m.documentType === "string" && m.documentType.length > 0) {
      return m.documentType;
    }
  } catch {
    // ignore malformed metadata
  }
  return "document";
}

function parseIsoToEpoch(iso: string): number | null {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? Math.floor(n / 1000) : null;
}

export { DEFAULT_INCLUDE_TYPES };
