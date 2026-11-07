// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, expect, test } from "vitest";

import { createDatabase } from "../../db.js";
import { listDocumentIds, upsertDocuments } from "./DocumentRepository.js";
import type { Db } from "../types.js";
import type { DocumentInput } from "@omnesis/types";

let db: Db;
let dbPath: string;

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  upsertDocuments(
    db,
    Array.from({ length: 97 }, (_, n): DocumentInput => ({
      providerId: "synth-notes" as DocumentInput["providerId"],
      sourceId: "synth-notes" as DocumentInput["sourceId"],
      externalId: `synth-note-${n}`,
      title: `Marathon plan ${n}`,
      content: `Week ${n} of the training block.`,
      contentHash: `synth-hash-${n}`,
      metadata: {},
      sourceCreatedAt: "2026-05-01T10:00:00.000Z",
      sourceUpdatedAt: "2026-05-01T10:00:00.000Z",
    })),
  );
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

test("listDocumentIds pages to the single-statement result", () => {
  const expected = db.prepare<[], string>("SELECT id FROM documents ORDER BY id").pluck().all();
  expect(expected).toHaveLength(97);
  for (const pageRows of [1, 2, 10, 96, 97, 98, 20_000])
    expect(listDocumentIds(db, pageRows)).toEqual(expected);
});
