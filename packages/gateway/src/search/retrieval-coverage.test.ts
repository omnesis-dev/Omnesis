// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { readRetrievalCoverage } from "./retrieval-coverage.js";

it("uses the published full-scan boundary, not partial page counts or visited watermark", () => {
  const index = new Database(":memory:"),
    source = new Database(":memory:");
  try {
    source.exec(
      "CREATE TABLE documents(id TEXT,updated_at TEXT); CREATE INDEX idx_documents_updated_at ON documents(updated_at); INSERT INTO documents VALUES('one','2027-01-04T10:00:00.000Z')",
    );
    index.exec(
      "CREATE TABLE watermark(key TEXT PRIMARY KEY,value TEXT); INSERT INTO watermark VALUES('last_updated_at','2027-01-04T10:00:00.000Z')",
    );
    expect(readRetrievalCoverage(index, source)).toMatchObject({
      status: "unknown",
      publishedThrough: null,
    });
    index.exec(
      "INSERT INTO watermark VALUES('published_scan_boundary','2027-01-04T09:00:00.000Z')",
    );
    const partial = readRetrievalCoverage(index, source);
    expect(partial.status).toBe("catching_up");
    expect(partial.notice).toContain("Do not infer");
    index.exec(
      "UPDATE watermark SET value='2027-01-04T10:00:00.000Z' WHERE key='published_scan_boundary'",
    );
    expect(readRetrievalCoverage(index, source)).toMatchObject({ status: "scanned" });
    expect(readRetrievalCoverage(index, source).notice).toContain("unindexable");
    source.exec("INSERT INTO documents VALUES('two','2027-01-04T10:01:00.000Z')");
    expect(readRetrievalCoverage(index, source).status).toBe("catching_up");
    expect(readRetrievalCoverage(index).status).toBe("unknown");
  } finally {
    index.close();
    source.close();
  }
});
