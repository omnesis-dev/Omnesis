// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * ExportService (#57) — portable, non-SQLite export of the user's indexed
 * data, so the corpus can leave Omnesis in an open format (JSONL/CSV)
 * regardless of the storage engine.
 *
 * One export produces `<configDir>/exports/<YYYY-MM-DDTHH-mm-ss>/` holding:
 *
 *   - format `json` (default):
 *       - `documents.jsonl` — one JSON object per line: id, sourceId,
 *         externalId, title, content, sourceUrl, the source/gateway
 *         timestamps, and the parsed metadata object. Streamed, so a large
 *         corpus never buffers in memory.
 *   - format `csv`:
 *       - `documents.csv` — a column subset (id, sourceId, externalId,
 *         title, sourceUrl, sourceCreatedAt, sourceUpdatedAt, updatedAt).
 *         The full `content` blob is deliberately omitted to keep the CSV
 *         a tabular index rather than a content dump — use the JSONL export
 *         for full content.
 *       - `<table>.csv` per analytics table (DuckDB), copied online through
 *         the injected `analyticsExport` port.
 *   - `manifest.json` — product version, timestamps, format, the optional
 *     source filter, total document count, a per-source breakdown, and
 *     encryption metadata when a root key wrapped the artifacts.
 *
 * When an install root key exists, completed export files are encrypted in
 * place as generated artifacts; this deliberately does not imply live
 * database encryption.
 *
 * The documents walk runs on a worker thread (`workers/export-worker.ts`):
 * better-sqlite3 is synchronous and serializing a multi-100k-doc corpus
 * would otherwise park the gateway main thread. Start/poll shape mirrors
 * BackupService: `start()` returns immediately with an `exportId`,
 * `getStatus()` serves running progress, and a second concurrent `start()`
 * is rejected with a 409.
 */

import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ENCRYPTED_ARTIFACT_SUFFIX,
  createLogger,
  encryptArtifactFileInPlace,
  resolveWorkerEntry,
  type SecretStoreBackend,
} from "@omnesis/core";
import { GATEWAY_VERSION } from "../../version.js";
import { ConflictError, ServiceUnavailableError } from "../errors.js";
import type {
  ExportFormat,
  ExportWorkerInput,
  ExportWorkerMessage,
} from "../../workers/export-protocol.js";

const log = createLogger("gateway:export");

const MANIFEST_NAME = "manifest.json";
const FULL_MANIFEST_NAME = "manifest.full.json";

/** Keyset page size for the documents walk — rows fetched (and flushed) per
 * batch in the worker. Bounds the worker's peak memory regardless of corpus
 * size. */
const DOCUMENTS_BATCH_SIZE = 1000;

export const exportManifestSchema = z.object({
  /** Gateway product version that produced the export. */
  version: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  format: z.enum(["json", "csv"]),
  /** Single-source filter, when the export was scoped. */
  sourceId: z.string().optional(),
  /** Total documents written. */
  documentCount: z.number().optional(),
  /** Documents written, broken down by source id. */
  perSource: z.record(z.string(), z.number()).optional(),
  /** Files written into the export directory. */
  files: z.array(z.string()),
  encryption: z
    .object({
      scheme: z.literal("omnesis.encrypted-artifact.v1"),
      key: z.literal("install-root-key-v1"),
    })
    .optional(),
  encryptedManifest: z.string().optional(),
  /** Analytics tables exported (CSV format only). */
  analyticsTables: z.array(z.string()).optional(),
});
export type ExportManifest = z.infer<typeof exportManifestSchema>;

export interface ExportResult {
  exportId: string;
  ok: boolean;
  error?: string;
  startedAt: string;
  finishedAt: string;
  path: string;
  format: ExportFormat;
  documentCount: number;
  files: string[];
}

export interface ExportStatus {
  running: boolean;
  current?: {
    exportId: string;
    startedAt: string;
    path: string;
    format: ExportFormat;
    sourceId?: string;
    /** Documents written so far. */
    documentCount: number;
  };
  lastResult?: ExportResult;
}

export interface ListedExport extends ExportManifest {
  /** Absolute path of the export directory. */
  path: string;
}

interface CurrentExport {
  exportId: string;
  startedAt: string;
  path: string;
  format: ExportFormat;
  sourceId?: string;
  documentCount: number;
}

export interface ExportServiceOptions {
  configDir: string;
  gatewayDbPath: string;
  gatewayDbKeyHex?: string;
  /**
   * Online export of every analytics table to `<destDir>/<table>.csv`.
   * Production wires `analyticsDb.exportTablesToCsv`; tests stub it.
   * Returns the table names written.
   */
  analyticsExport: (destDir: string) => Promise<string[]>;
  /** Defaults to `<configDir>/exports`. */
  exportsDir?: string;
  /** Clock seam (export directory names derive from it). */
  now?: () => Date;
  /** Test seam; production uses OMNESIS_SECRET_STORE/auto. */
  secretStoreBackend?: SecretStoreBackend;
}

export class ExportService {
  private readonly exportsDir: string;
  private readonly now: () => Date;
  private current: CurrentExport | null = null;
  private lastResult: ExportResult | undefined;
  private runPromise: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ExportServiceOptions) {
    this.exportsDir = opts.exportsDir ?? join(opts.configDir, "exports");
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Kick off an export. Returns immediately; progress is polled via
   * `getStatus()`. Throws 409 when an export is already running and 503
   * when the gateway database is missing.
   */
  start(opts?: { format?: ExportFormat; sourceId?: string }): { exportId: string } {
    if (this.current) {
      throw new ConflictError("An export is already running — poll GET /admin/export/status");
    }
    if (!existsSync(this.opts.gatewayDbPath)) {
      throw new ServiceUnavailableError(
        `Gateway database not found at ${this.opts.gatewayDbPath} — nothing to export`,
      );
    }

    mkdirSync(this.exportsDir, { recursive: true });

    const exportId = randomUUID();
    const startedAt = this.now().toISOString();
    const path = this.createExportDir(startedAt);
    const format: ExportFormat = opts?.format ?? "json";

    const current: CurrentExport = {
      exportId,
      startedAt,
      path,
      format,
      ...(opts?.sourceId ? { sourceId: opts.sourceId } : {}),
      documentCount: 0,
    };
    this.current = current;
    log.info(
      `Export ${exportId} started: dir=${path} format=${format}${current.sourceId ? ` source=${current.sourceId}` : ""}`,
    );
    // run() handles every failure internally (records lastResult, cleans
    // up); the stored promise never rejects, so whenIdle() can await it.
    this.runPromise = this.run(current);
    return { exportId };
  }

  getStatus(): ExportStatus {
    return {
      running: this.current !== null,
      ...(this.current
        ? {
            current: {
              exportId: this.current.exportId,
              startedAt: this.current.startedAt,
              path: this.current.path,
              format: this.current.format,
              ...(this.current.sourceId ? { sourceId: this.current.sourceId } : {}),
              documentCount: this.current.documentCount,
            },
          }
        : {}),
      ...(this.lastResult ? { lastResult: this.lastResult } : {}),
    };
  }

  /** Completed exports (directories with a parseable manifest), newest first. */
  list(): ListedExport[] {
    if (!existsSync(this.exportsDir)) return [];
    const out: ListedExport[] = [];
    for (const entry of readdirSync(this.exportsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.exportsDir, entry.name);
      const manifestPath = join(dir, MANIFEST_NAME);
      if (!existsSync(manifestPath)) continue;
      try {
        const parsed = exportManifestSchema.safeParse(
          JSON.parse(readFileSync(manifestPath, "utf8")),
        );
        if (!parsed.success) {
          log.warn(`Skipping export with invalid manifest: ${manifestPath}`);
          continue;
        }
        out.push({ ...parsed.data, path: dir });
      } catch (err) {
        log.warn(
          `Skipping unreadable export manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return out;
  }

  /** Resolves once no export is in flight. Test + shutdown hook. */
  whenIdle(): Promise<void> {
    return this.runPromise;
  }

  /** Timestamped directory name; colon-free for filesystem portability. */
  private createExportDir(startedAt: string): string {
    const dirName = startedAt.slice(0, 19).replace(/:/g, "-");
    let path = join(this.exportsDir, dirName);
    for (let n = 2; existsSync(path); n++) {
      path = join(this.exportsDir, `${dirName}-${n}`);
    }
    mkdirSync(path, { recursive: true });
    return path;
  }

  private async run(cur: CurrentExport): Promise<void> {
    const startMs = Date.now();
    try {
      const documentsFile = cur.format === "csv" ? "documents.csv" : "documents.jsonl";
      const input: ExportWorkerInput = {
        gatewayDbPath: this.opts.gatewayDbPath,
        ...(this.opts.gatewayDbKeyHex ? { gatewayDbKeyHex: this.opts.gatewayDbKeyHex } : {}),
        destPath: join(cur.path, documentsFile),
        format: cur.format,
        ...(cur.sourceId ? { sourceId: cur.sourceId } : {}),
        batchSize: DOCUMENTS_BATCH_SIZE,
      };
      const { perSource } = await this.runWorker(input, cur);
      const files = [documentsFile];

      // CSV exports also include each analytics table as its own CSV; the
      // copies go through the live DuckDB pool (a second instance can't open
      // the locked file). JSONL exports cover documents only — analytics
      // rows already round-trip via `omnesis sql` / the analytics API.
      let analyticsTables: string[] = [];
      if (cur.format === "csv") {
        analyticsTables = await this.opts.analyticsExport(cur.path);
        for (const table of analyticsTables) files.push(`${table}.csv`);
        log.info(`Exported ${analyticsTables.length} analytics table(s) to CSV`);
      }
      const encrypted = await this.encryptExportFiles(cur, files);
      const manifestFiles = encrypted.files;

      const finishedAt = this.now().toISOString();
      const manifestBase: ExportManifest = {
        version: GATEWAY_VERSION,
        startedAt: cur.startedAt,
        finishedAt,
        format: cur.format,
        ...(cur.sourceId ? { sourceId: cur.sourceId } : {}),
        documentCount: cur.documentCount,
        perSource,
        files: [...manifestFiles, MANIFEST_NAME],
        ...(encrypted.encrypted
          ? {
              encryption: {
                scheme: "omnesis.encrypted-artifact.v1",
                key: "install-root-key-v1",
              },
            }
          : {}),
        analyticsTables,
      };
      const manifest = encrypted.encrypted
        ? await this.writeEncryptedFullManifest(cur, manifestBase)
        : manifestBase;
      writeFileSync(join(cur.path, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");

      this.lastResult = {
        exportId: cur.exportId,
        ok: true,
        startedAt: cur.startedAt,
        finishedAt,
        path: cur.path,
        format: cur.format,
        documentCount: cur.documentCount,
        files: manifest.files,
      };
      log.info(
        `Export ${cur.exportId} complete: ${cur.documentCount} documents, ${files.length} file(s) in ${Date.now() - startMs}ms at ${cur.path}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastResult = {
        exportId: cur.exportId,
        ok: false,
        error: message,
        startedAt: cur.startedAt,
        finishedAt: this.now().toISOString(),
        path: cur.path,
        format: cur.format,
        documentCount: cur.documentCount,
        files: [],
      };
      // Drop the partial directory so a failed run doesn't strand a
      // half-written export (list() would skip it anyway — no manifest —
      // but the disk space matters).
      try {
        rmSync(cur.path, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      log.error(`Export ${cur.exportId} failed after ${Date.now() - startMs}ms: ${message}`);
    } finally {
      this.current = null;
    }
  }

  private runWorker(
    input: ExportWorkerInput,
    cur: CurrentExport,
  ): Promise<{ perSource: Record<string, number> }> {
    const entry = resolveWorkerEntry(
      "../../workers/export-worker.ts",
      import.meta.url,
      "../../workers/register-tsx.mjs",
    );
    return new Promise((resolve, reject) => {
      const worker = new Worker(entry.url, { workerData: input, execArgv: entry.execArgv });
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      worker.on("message", (msg: ExportWorkerMessage) => {
        switch (msg.type) {
          case "progress":
            cur.documentCount = msg.documents;
            break;
          case "done":
            cur.documentCount = msg.documents;
            settle(() => resolve({ perSource: msg.perSource }));
            break;
          case "error":
            settle(() => reject(new Error(msg.error)));
            break;
        }
      });
      worker.on("error", (err) => settle(() => reject(err)));
      worker.on("exit", (code) =>
        settle(() => reject(new Error(`export worker exited prematurely (code ${code})`))),
      );
    });
  }

  private async encryptExportFiles(
    cur: CurrentExport,
    files: string[],
  ): Promise<{ encrypted: boolean; files: string[] }> {
    let encryptedAny = false;
    const out: string[] = [];
    for (const file of files) {
      const result = await encryptArtifactFileInPlace(join(cur.path, file), {
        configDir: this.opts.configDir,
        backend: this.opts.secretStoreBackend,
        scope: `export:${cur.exportId}:${file}`,
      });
      if (result.encrypted) {
        encryptedAny = true;
        out.push(`${file}${ENCRYPTED_ARTIFACT_SUFFIX}`);
        log.info(`Encrypted export artifact ${file}${ENCRYPTED_ARTIFACT_SUFFIX}`);
      } else {
        out.push(file);
      }
    }
    return { encrypted: encryptedAny, files: out };
  }

  private async writeEncryptedFullManifest(
    cur: CurrentExport,
    fullManifest: ExportManifest,
  ): Promise<ExportManifest> {
    const fullPath = join(cur.path, FULL_MANIFEST_NAME);
    writeFileSync(fullPath, JSON.stringify(fullManifest, null, 2) + "\n", { mode: 0o600 });
    const result = await encryptArtifactFileInPlace(fullPath, {
      configDir: this.opts.configDir,
      backend: this.opts.secretStoreBackend,
      scope: `export:${cur.exportId}:${FULL_MANIFEST_NAME}`,
    });
    if (!result.encrypted) {
      throw new Error(
        "Export artifacts were encrypted but the full manifest could not be encrypted",
      );
    }
    return {
      version: fullManifest.version,
      startedAt: fullManifest.startedAt,
      finishedAt: fullManifest.finishedAt,
      format: fullManifest.format,
      files: [
        ...fullManifest.files.filter((name) => name !== MANIFEST_NAME),
        `${FULL_MANIFEST_NAME}${ENCRYPTED_ARTIFACT_SUFFIX}`,
      ],
      encryption: fullManifest.encryption,
      encryptedManifest: `${FULL_MANIFEST_NAME}${ENCRYPTED_ARTIFACT_SUFFIX}`,
    };
  }
}
