// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * ExportService coverage (#57): the worker-thread documents walk to JSONL
 * and CSV against a small temp SQLite store, manifest correctness + counts,
 * the `--source` (sourceId) filter, CSV field escaping (commas / quotes /
 * newlines), the analytics-table CSV export through a real DuckDB pool,
 * single-flight 409, the failure cleanup path, and list().
 *
 * All fixture data is invented (fictional names, example.com addresses).
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  decryptArtifactFileToBuffer,
  ensureInstallRootKey,
  isEncryptedArtifactFile,
  markSecretFileEncryptionRequiredSync,
} from "@omnesis/core";
import { GATEWAY_VERSION } from "../../version.js";
import { createDatabase } from "../../db.js";
import { AnalyticsDb } from "../../analytics-db.js";
import { ConflictError, ServiceUnavailableError } from "../errors.js";
import { ExportService, exportManifestSchema, type ExportServiceOptions } from "./ExportService.js";
import type Database from "better-sqlite3";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

interface DocFixture {
  sourceId: string;
  externalId: string;
  title: string;
  content: string;
  sourceUrl: string | null;
  metadata: Record<string, unknown>;
}

let configDir: string;
let gatewayDbPath: string;
let db: Database.Database;

/** Insert a document row directly so the test controls every field value
 * (including titles with embedded commas/quotes/newlines for CSV escaping). */
function insertDoc(doc: DocFixture, createdAt: string): void {
  db.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    doc.sourceId.split(":")[0],
    doc.sourceId,
    doc.externalId,
    doc.title,
    doc.content,
    `hash-${doc.externalId}`,
    JSON.stringify(doc.sourceUrl ? { ...doc.metadata, sourceUrl: doc.sourceUrl } : doc.metadata),
    createdAt,
    createdAt,
    createdAt,
    createdAt,
    // The canonical matching key differs from the published link, so the
    // assertions below prove the export carries the openable original.
    doc.sourceUrl ? `${doc.sourceUrl}/canonical` : null,
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-export-svc-"));
  gatewayDbPath = join(configDir, "omnesis.db");
  db = createDatabase(gatewayDbPath);

  insertDoc(
    {
      sourceId: "gmail:maya@example.com",
      externalId: "msg-1",
      title: "Quarterly review notes",
      content: "Numbers looked solid this quarter.",
      sourceUrl: "https://mail.example.com/msg-1",
      metadata: { documentType: "email", from: "Maya Reeves" },
    },
    "2026-01-10T09:00:00.000Z",
  );
  // A title with a comma, a double-quote, and a newline — the CSV escaper
  // must quote-wrap and double the embedded quote.
  insertDoc(
    {
      sourceId: "gmail:maya@example.com",
      externalId: "msg-2",
      title: 'Lunch, "the usual"\nand a follow-up',
      content: "See you at noon.",
      sourceUrl: null,
      metadata: { documentType: "email" },
    },
    "2026-01-11T09:00:00.000Z",
  );
  insertDoc(
    {
      sourceId: "notion:workspace-7",
      externalId: "page-9",
      title: "Project Northstar plan",
      content: "Milestones and owners.",
      sourceUrl: "https://notion.example.com/page-9",
      metadata: { documentType: "page" },
    },
    "2026-01-12T09:00:00.000Z",
  );
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(gatewayDbPath + suffix)) unlinkSync(gatewayDbPath + suffix);
  }
  rmSync(configDir, { recursive: true, force: true });
});

function makeService(overrides?: Partial<ExportServiceOptions>): ExportService {
  return new ExportService({
    configDir,
    gatewayDbPath,
    analyticsExport: async () => [],
    ...overrides,
  });
}

function singleExportDir(): string {
  const exportsDir = join(configDir, "exports");
  const dirs = readdirSync(exportsDir);
  expect(dirs.length).toBe(1);
  return join(exportsDir, dirs[0]);
}

describe("ExportService", () => {
  test("JSON export writes one JSONL line per document plus a correct manifest", async () => {
    const service = makeService();
    const { exportId } = service.start();
    expect(exportId).toBeTruthy();
    expect(service.getStatus().running).toBe(true);
    await service.whenIdle();

    const status = service.getStatus();
    expect(status.running).toBe(false);
    expect(status.lastResult?.ok).toBe(true);
    expect(status.lastResult?.exportId).toBe(exportId);
    expect(status.lastResult?.documentCount).toBe(3);

    const dir = singleExportDir();
    const lines = readFileSync(join(dir, "documents.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    // Every line is a well-formed object carrying the full shape.
    for (const obj of parsed) {
      for (const key of ["id", "sourceId", "externalId", "title", "content", "metadata"]) {
        expect(obj).toHaveProperty(key);
      }
    }
    // metadata is a parsed object, not a string-in-a-string.
    const emailLine = parsed.find((o) => o.externalId === "msg-1")!;
    expect((emailLine.metadata as Record<string, unknown>).from).toBe("Maya Reeves");
    expect(emailLine.content).toBe("Numbers looked solid this quarter.");
    expect(emailLine.sourceUrl).toBe("https://mail.example.com/msg-1");

    const manifest = exportManifestSchema.parse(
      JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
    );
    expect(manifest.version).toBe(GATEWAY_VERSION);
    expect(manifest.format).toBe("json");
    expect(manifest.documentCount).toBe(3);
    expect(manifest.perSource).toEqual({ "gmail:maya@example.com": 2, "notion:workspace-7": 1 });
    expect(manifest.files).toContain("documents.jsonl");
    expect(manifest.files).toContain("manifest.json");
    expect(Date.parse(manifest.startedAt)).not.toBeNaN();
    expect(Date.parse(manifest.finishedAt)).not.toBeNaN();
  });

  test("CSV export writes a header + one row per document and escapes special fields", async () => {
    const service = makeService();
    service.start({ format: "csv" });
    await service.whenIdle();
    expect(service.getStatus().lastResult?.ok).toBe(true);

    const dir = singleExportDir();
    const csv = readFileSync(join(dir, "documents.csv"), "utf8");
    const header = csv.split("\n")[0];
    expect(header).toBe(
      "id,sourceId,externalId,title,sourceUrl,sourceCreatedAt,sourceUpdatedAt,updatedAt",
    );
    // The full content blob is intentionally absent from the CSV.
    expect(header).not.toContain("content");

    // The comma/quote/newline title must be quote-wrapped with the embedded
    // quote doubled, and its embedded newline must NOT split the logical row.
    expect(csv).toContain('"Lunch, ""the usual""\nand a follow-up"');

    // Parse the CSV honoring quoted fields to count logical rows.
    const rows = parseCsv(csv);
    // header + 3 documents
    expect(rows.length).toBe(4);
    expect(rows[0]).toEqual([
      "id",
      "sourceId",
      "externalId",
      "title",
      "sourceUrl",
      "sourceCreatedAt",
      "sourceUpdatedAt",
      "updatedAt",
    ]);
    const titles = rows.slice(1).map((r) => r[3]);
    expect(rows.find((r) => r[2] === "msg-1")?.[4]).toBe("https://mail.example.com/msg-1");
    expect(titles).toContain('Lunch, "the usual"\nand a follow-up');
    expect(titles).toContain("Quarterly review notes");
  });

  test("--source (sourceId) filter limits the export to one source", async () => {
    const service = makeService();
    service.start({ sourceId: "gmail:maya@example.com" });
    await service.whenIdle();

    const result = service.getStatus().lastResult;
    expect(result?.ok).toBe(true);
    expect(result?.documentCount).toBe(2);

    const dir = singleExportDir();
    const lines = readFileSync(join(dir, "documents.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect((JSON.parse(line) as { sourceId: string }).sourceId).toBe("gmail:maya@example.com");
    }
    const manifest = exportManifestSchema.parse(
      JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
    );
    expect(manifest.sourceId).toBe("gmail:maya@example.com");
    expect(manifest.perSource).toEqual({ "gmail:maya@example.com": 2 });
  });

  test("encrypts export artifacts when an install root key exists", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    const service = makeService({ secretStoreBackend: "file" });
    service.start();
    await service.whenIdle();
    expect(service.getStatus().lastResult?.ok).toBe(true);

    const dir = singleExportDir();
    expect(existsSync(join(dir, "documents.jsonl"))).toBe(false);
    expect(isEncryptedArtifactFile(join(dir, "documents.jsonl.enc"))).toBe(true);

    const decrypted = await decryptArtifactFileToBuffer(join(dir, "documents.jsonl.enc"), {
      backend: "file",
      configDir,
    });
    const lines = decrypted.toString("utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    expect(lines.map((line) => (JSON.parse(line) as { externalId: string }).externalId)).toContain(
      "msg-1",
    );

    const manifest = exportManifestSchema.parse(
      JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
    );
    expect(manifest.encryption).toEqual({
      scheme: "omnesis.encrypted-artifact.v1",
      key: "install-root-key-v1",
    });
    expect(manifest.encryptedManifest).toBe("manifest.full.json.enc");
    expect(manifest.documentCount).toBeUndefined();
    expect(manifest.perSource).toBeUndefined();
    expect(manifest.files).toContain("documents.jsonl.enc");
    expect(manifest.files).toContain("manifest.full.json.enc");
    expect(manifest.files).not.toContain("documents.jsonl");
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).not.toContain("gmail:maya");

    const fullManifest = exportManifestSchema.parse(
      JSON.parse(
        (
          await decryptArtifactFileToBuffer(join(dir, "manifest.full.json.enc"), {
            backend: "file",
            configDir,
          })
        ).toString("utf8"),
      ),
    );
    expect(fullManifest.documentCount).toBe(3);
    expect(fullManifest.perSource).toEqual({
      "gmail:maya@example.com": 2,
      "notion:workspace-7": 1,
    });
  });

  test("fails closed when keyring-backed files are required but the root key is unavailable", async () => {
    markSecretFileEncryptionRequiredSync(configDir);
    const service = makeService({ secretStoreBackend: "file" });
    service.start();
    await service.whenIdle();

    const result = service.getStatus().lastResult;
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/install root key/);
    expect(readdirSync(join(configDir, "exports"))).toEqual([]);
  });

  test("CSV export writes each analytics table to its own CSV via the live pool", async () => {
    const analyticsDbPath = join(configDir, "analytics.db");
    const analyticsDb = new AnalyticsDb(analyticsDbPath);
    await analyticsDb.open();
    try {
      const schema: AnalyticsTableSchema = {
        tableName: "workouts",
        displayName: "Workouts",
        description: "Logged workouts",
        columns: [
          { name: "id", type: "VARCHAR", description: "Record ID" },
          { name: "note", type: "VARCHAR", description: "Free-form note", nullable: true },
          { name: "minutes", type: "DOUBLE", description: "Duration", nullable: true },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["id"], keyColumns: ["id", "minutes"] },
      };
      await analyticsDb.ensureTable(schema, "strava:athlete-1");
      await analyticsDb.insertRecords(
        "workouts",
        [
          { id: "w1", note: 'Morning run, "easy" pace', minutes: 32 },
          { id: "w2", note: "Evening ride", minutes: 58 },
        ],
        ["id"],
      );

      const service = makeService({
        analyticsExport: (destDir) => analyticsDb.exportTablesToCsv(destDir),
      });
      service.start({ format: "csv" });
      await service.whenIdle();
      expect(service.getStatus().lastResult?.ok).toBe(true);

      const dir = singleExportDir();
      expect(existsSync(join(dir, "workouts.csv"))).toBe(true);
      const workoutsCsv = readFileSync(join(dir, "workouts.csv"), "utf8");
      // DuckDB writes a header row and quotes the comma/quote-bearing note.
      expect(workoutsCsv.split("\n")[0]).toContain("id");
      expect(workoutsCsv).toContain('"Morning run, ""easy"" pace"');
      expect(workoutsCsv).toContain("w2");
      // The internal bookkeeping table is never exported.
      expect(existsSync(join(dir, "_analytics_catalog.csv"))).toBe(false);

      const manifest = exportManifestSchema.parse(
        JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
      );
      expect(manifest.analyticsTables).toEqual(["workouts"]);
      expect(manifest.files).toContain("workouts.csv");
    } finally {
      await analyticsDb.close();
    }
  });

  test("JSON export never touches the analytics export port", async () => {
    let called = false;
    const service = makeService({
      analyticsExport: async () => {
        called = true;
        return [];
      },
    });
    service.start({ format: "json" });
    await service.whenIdle();
    expect(service.getStatus().lastResult?.ok).toBe(true);
    expect(called).toBe(false);
  });

  test("second concurrent start() is rejected with a 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const service = makeService({
      analyticsExport: async () => {
        await gate;
        return [];
      },
    });
    const { exportId } = service.start({ format: "csv" });

    let thrown: unknown;
    try {
      service.start();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as ConflictError).status).toBe(409);

    release();
    await service.whenIdle();
    expect(service.getStatus().lastResult?.exportId).toBe(exportId);

    // Once idle, a new export is accepted again.
    const second = service.start();
    expect(second.exportId).not.toBe(exportId);
    await service.whenIdle();
  });

  test("a missing gateway database fails fast with a 503", () => {
    rmSync(gatewayDbPath, { force: true });
    const service = makeService();
    let thrown: unknown;
    try {
      service.start();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServiceUnavailableError);
    expect((thrown as ServiceUnavailableError).status).toBe(503);
    expect(service.getStatus().running).toBe(false);
  });

  test("a failed analytics export records the error and removes the partial dir", async () => {
    const service = makeService({
      analyticsExport: async () => {
        throw new Error("duckdb copy exploded");
      },
    });
    const { exportId } = service.start({ format: "csv" });
    await service.whenIdle();

    const status = service.getStatus();
    expect(status.running).toBe(false);
    expect(status.lastResult?.ok).toBe(false);
    expect(status.lastResult?.exportId).toBe(exportId);
    expect(status.lastResult?.error).toContain("duckdb copy exploded");
    expect(readdirSync(join(configDir, "exports"))).toEqual([]);
    expect(service.list()).toEqual([]);
  });

  test("list() returns manifests newest-first and collisions get a dir suffix", async () => {
    const t1 = new Date("2026-06-01T10:00:00.000Z");
    const t2 = new Date("2026-06-01T10:00:00.000Z");
    let calls = 0;
    const service = makeService({
      now: () => (calls++ < 2 ? t1 : t2),
    });
    service.start();
    await service.whenIdle();
    service.start({ sourceId: "notion:workspace-7" });
    await service.whenIdle();

    const exports = service.list();
    expect(exports.length).toBe(2);
    expect(exports[0].path).not.toBe(exports[1].path);
    const dirs = readdirSync(join(configDir, "exports")).sort();
    expect(dirs).toEqual(["2026-06-01T10-00-00", "2026-06-01T10-00-00-2"]);

    // Stray dirs without a manifest are ignored.
    rmSync(join(configDir, "exports", "stray"), { recursive: true, force: true });
    expect(service.list().length).toBe(2);
  });
});

/** Minimal RFC 4180 CSV parser for the test assertions: splits into rows of
 * fields, honoring quoted fields with embedded commas, newlines, and
 * doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  // Trailing field/row when the text doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
