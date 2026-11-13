// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The background runtime's handling of `brain.excludedSources`: runs queued
 * for an excluded subject settle in preflight without a model call, and every
 * tool a background run receives refuses a call naming an excluded document.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { resolveBrainSettings } from "../config.js";
import { createCognitionRuntime, type CognitionRuntimeDeps } from "./runtime.js";
import { EXCLUDED_SOURCE_ERROR_CODE } from "./source-fence.js";
import type { ClaimedCognitionRun } from "../storage/types.js";
import type Database from "better-sqlite3";

const log = createLogger("test").child("runtime-excluded-sources");
const NOW = Date.parse("2026-07-02T10:00:00.000Z");

let path: string;
let db: Database.Database;
let excludedSources: string[];

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  excludedSources = ["codex"];
  const insert = db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
       metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'prov', ?, ?, 't', 'c', 'h', '{}', '2026-07-01', '2026-07-01', '2026-07-01', '2026-07-01')`,
  );
  insert.run("doc-session", "codex:local", "ext-session");
  insert.run("doc-mail", "gmail:maya@example.com", "ext-mail");
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

function runtime() {
  return createCognitionRuntime({
    db,
    writeGate: directWriteGate(db),
    searchPipeline: {} as unknown as CognitionRuntimeDeps["searchPipeline"],
    syncStatus: {} as unknown as CognitionRuntimeDeps["syncStatus"],
    analyticsDb: {} as unknown as CognitionRuntimeDeps["analyticsDb"],
    getSettings: () => resolveBrainSettings({ excludedSources }),
    clock: () => NOW,
    log,
  });
}

function run(kind: ClaimedCognitionRun["kind"], payload: unknown): ClaimedCognitionRun {
  return { id: `run_${kind}`, kind, payload, payloadJson: JSON.stringify(payload), attempts: 1 };
}

describe("runs queued for an excluded subject", () => {
  test("settle in preflight without a model call", async () => {
    const rt = await runtime();
    const data = (docId: string) => run("data", { docId, event: "created", datumAt: NOW - 1000 });
    expect(await rt.preflight!(data("doc-session"))).toBe("complete");
    expect(await rt.preflight!(run("bootstrap", { docId: "doc-session", datumAt: 1 }))).toBe(
      "complete",
    );
    expect(
      await rt.preflight!(
        run("daily", { sourceId: "codex:local", dateFrom: "2026-07-01", dateTo: "2026-07-02" }),
      ),
    ).toBe("complete");
    expect(await rt.preflight!(data("doc-mail"))).toBe("continue");
    expect(
      await rt.preflight!(
        run("daily", { sourceId: "bank:main", dateFrom: "2026-07-01", dateTo: "2026-07-02" }),
      ),
    ).toBe("continue");
  });

  test("continue again once the exclusion is lifted", async () => {
    const rt = await runtime();
    excludedSources = [];
    expect(
      await rt.preflight!(
        run("data", {
          docId: "doc-session",
          event: "created",
          datumAt: NOW - 1000,
        }),
      ),
    ).toBe("continue");
  });
});

describe("background tools", () => {
  test("refuse a call naming an excluded document before it runs", async () => {
    const rt = await runtime();
    const tools = rt.buildTools(run("synthesis", { focus: "synthesis" }));
    const fetchMany = tools.find((tool) => tool.name === "fetch_many")!;
    const result = await fetchMany.invoke(
      { documents: [{ documentId: "doc-session" }] },
      {} as never,
    );
    expect(result).toMatchObject({ kind: "error", code: EXCLUDED_SOURCE_ERROR_CODE });
  });
});

describe("the interactive agent's own tools", () => {
  test("are not fenced", async () => {
    const rt = await runtime();
    for (const tool of rt.buildOwnTools("user:conversation:test")) {
      const result = await tool.invoke({ docId: "doc-session" }, {} as never).catch(() => null);
      expect((result as { code?: string } | null)?.code).not.toBe(EXCLUDED_SOURCE_ERROR_CODE);
    }
  });
});
