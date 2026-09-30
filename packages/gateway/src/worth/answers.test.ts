// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../db.js";
import { deleteDocumentsByIds, upsertDocuments } from "../data/repositories/DocumentRepository.js";
import { findWorthAnswer, recordWorthAnswers, type WorthAnswer } from "./answers.js";
import type { Db } from "../data/types.js";
import type { DocumentInput } from "@omnesis/types";

describe("worth answers", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
  });

  function seed(externalId: string): string {
    const doc: DocumentInput = {
      providerId: "test" as DocumentInput["providerId"],
      sourceId: "mail:test" as DocumentInput["sourceId"],
      externalId,
      title: "Your order has shipped",
      content: "It arrives on 12 October.",
      contentHash: `hash-${externalId}`,
      metadata: { documentType: "email" },
      sourceCreatedAt: "2026-10-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-10-01T00:00:00.000Z",
    };
    upsertDocuments(db, [doc]);
    return db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId)!.id;
  }

  const answer = (
    subjectDocumentId: string,
    overrides: Partial<WorthAnswer> = {},
  ): WorthAnswer => ({
    id: `wa_${randomUUID()}`,
    subjectDocumentId,
    contentHash: "hash-a",
    rubricVersion: "email-worth-v1",
    requestedModelId: "jev-test",
    modelId: "jev-test",
    score: 1.5,
    answeredAt: 1,
    ...overrides,
  });

  const question = (subjectDocumentId: string) => ({
    subjectDocumentId,
    contentHash: "hash-a",
    rubricVersion: "email-worth-v1",
    requestedModelId: "jev-test",
  });

  it("finds an answer only for exactly its question", () => {
    const id = seed("a");
    recordWorthAnswers(db, [answer(id, { id: "wa_1" })]);
    expect(findWorthAnswer(db, question(id))).toMatchObject({ id: "wa_1", score: 1.5 });
    expect(findWorthAnswer(db, { ...question(id), contentHash: "hash-b" })).toBeNull();
    expect(findWorthAnswer(db, { ...question(id), rubricVersion: "email-worth-v2" })).toBeNull();
    expect(findWorthAnswer(db, { ...question(id), requestedModelId: "jev-other" })).toBeNull();
  });

  it("keeps the first answer when two gates answer the same question", () => {
    const id = seed("a");
    recordWorthAnswers(db, [answer(id, { id: "wa_first", score: 0.2 })]);
    recordWorthAnswers(db, [answer(id, { id: "wa_second", score: 2.8 })]);
    expect(findWorthAnswer(db, question(id))).toMatchObject({ id: "wa_first", score: 0.2 });
  });

  it("drops an answer for an email deleted before it was recorded, and deletes answers with the email", () => {
    const kept = seed("kept");
    recordWorthAnswers(db, [answer("gone-document"), answer(kept)]);
    const count = () =>
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM worth_answers").get()!.n;
    expect(count()).toBe(1);
    deleteDocumentsByIds(db, [kept]);
    expect(count()).toBe(0);
  });
});
