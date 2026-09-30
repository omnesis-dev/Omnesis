// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createDatabase } from "../../db.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { insertCognitionDecision } from "../../brain/storage/decisions.js";
import { findWorthAnswer } from "../../worth/answers.js";
import { WORTH_GATE_RUBRIC_VERSION } from "../../worth/rubric.js";
import { applyExtractedDates } from "./storage.js";
import {
  applyMentionJudgements,
  countPendingMentionJudgements,
  fetchPendingMentionJudgements,
  requeueStaleMentionJudgements,
  type PendingMentionJudgement,
} from "./mention-judgements.js";
import type { Db } from "../../data/types.js";
import type { DocumentInput, ExtractedDate } from "@omnesis/types";

const MODEL = "jev-test";

const DAY: ExtractedDate = {
  kind: "date",
  resolvedStart: "2026-10-12",
  resolvedEnd: null,
  relative: false,
  text: "12 October",
  timex: "XXXX-10-12",
  charStart: 0,
  charEnd: 10,
};
const MENTION = { startDay: "2026-10-12", endDay: "2026-10-13", deadline: false };

describe("mention judgements", () => {
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

  function seed(
    externalId: string,
    opts: { documentType?: string; hash?: string; metadata?: Record<string, unknown> } = {},
  ): string {
    const doc: DocumentInput = {
      providerId: "test" as DocumentInput["providerId"],
      sourceId: "mail:test" as DocumentInput["sourceId"],
      externalId,
      title: `Subject of ${externalId}`,
      content: "See you on 12 October.",
      contentHash: opts.hash ?? `hash-${externalId}`,
      metadata: {
        documentType: opts.documentType ?? "email",
        people: [{ role: "sender", name: "Maya Reeves", emails: ["maya@example.com"] }],
        ...opts.metadata,
      },
      sourceCreatedAt: "2026-10-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-10-01T00:00:00.000Z",
    };
    upsertDocuments(db, [doc]);
    return db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId)!.id;
  }

  function extract(id: string, withMention = true): void {
    applyExtractedDates(db, [
      { id, dates: [DAY], mentions: [withMention ? MENTION : null], threadKey: null },
    ]);
  }

  function verdictOf(id: string): string | undefined {
    return db
      .prepare<
        [string],
        { verdict: string }
      >("SELECT verdict FROM date_mention_judgements WHERE document_id = ?")
      .get(id)?.verdict;
  }

  const fetch = (now = 0, model = MODEL): PendingMentionJudgement[] =>
    fetchPendingMentionJudgements(db, 10, WORTH_GATE_RUBRIC_VERSION, model, now);

  let answerSeq = 0;

  /**
   * Settle a fetched item the way the gate does: a fresh answer for an ask is
   * recorded as the email's shared answer, a stored answer is only applied.
   */
  function settle(item: PendingMentionJudgement, score?: number): number {
    if (item.kind !== "ask" && item.kind !== "answered")
      throw new Error(`cannot score ${item.kind}`);
    const contentHash = item.kind === "ask" ? item.contentHash : item.answer.contentHash;
    const value = item.kind === "ask" ? score! : item.answer.score;
    return applyMentionJudgements(
      db,
      [
        {
          documentId: item.documentId,
          generation: item.generation,
          verdict: value >= 1.08 ? "keep" : "drop",
          subjectDocumentId: item.subjectDocumentId,
          contentHash,
          rubricVersion: WORTH_GATE_RUBRIC_VERSION,
          score: value,
          judgedAt: 1,
        },
      ],
      [],
      item.kind === "ask"
        ? [
            {
              id: `wa_${++answerSeq}`,
              subjectDocumentId: item.subjectDocumentId,
              contentHash,
              rubricVersion: WORTH_GATE_RUBRIC_VERSION,
              requestedModelId: MODEL,
              modelId: MODEL,
              score: value,
              answeredAt: 1,
            },
          ]
        : [],
    );
  }

  const only = (id: string): PendingMentionJudgement =>
    fetch().find((item) => item.documentId === id)!;

  it("queues a document extraction leaves with a mention, and only that one", () => {
    const withMention = seed("a");
    const without = seed("b");
    extract(withMention);
    extract(without, false);
    expect(verdictOf(withMention)).toBe("pending");
    expect(verdictOf(without)).toBeUndefined();
    expect(countPendingMentionJudgements(db)).toBe(1);

    // A rescan that finds no mention any more takes the document off the queue.
    extract(withMention, false);
    expect(verdictOf(withMention)).toBeUndefined();
  });

  it("asks about an email with the worth state of its subject, sender and body", () => {
    const id = seed("a");
    extract(id);
    expect(only(id)).toMatchObject({
      kind: "ask",
      subjectDocumentId: id,
      contentHash: "hash-a",
      state: {
        subject: "Subject of a",
        from: "Maya Reeves <maya@example.com>",
        body: "See you on 12 October.",
      },
    });
  });

  it("exempts a document that is not an email, and any document or email with structured dates", () => {
    const note = seed("note", { documentType: "note" });
    const booking = seed("booking", { metadata: { scheduledAt: "2026-10-12T09:00:00Z" } });
    seed("promo-mail");
    const invoice = seed("promo-mail/invoice", {
      documentType: "attachment",
      metadata: { extra: { parentExternalId: "promo-mail" }, dueAt: "2026-10-12" },
    });
    for (const id of [note, booking, invoice]) extract(id);
    const kinds = Object.fromEntries(fetch().map((p) => [p.documentId, p.kind]));
    expect(kinds).toEqual({ [note]: "exempt", [booking]: "exempt", [invoice]: "exempt" });
  });

  it("records the answer it asked for as the email's shared answer", () => {
    const id = seed("a");
    extract(id);
    settle(only(id), 0.4);
    expect(
      findWorthAnswer(db, {
        subjectDocumentId: id,
        contentHash: "hash-a",
        rubricVersion: WORTH_GATE_RUBRIC_VERSION,
        requestedModelId: MODEL,
      }),
    ).toMatchObject({ score: 0.4, modelId: MODEL });
  });

  it("judges an attachment by its email and applies the email's answer", () => {
    const email = seed("thread-1");
    const attachment = seed("thread-1/att", {
      documentType: "attachment",
      metadata: { extra: { parentExternalId: "thread-1" } },
    });
    extract(attachment);
    expect(only(attachment)).toMatchObject({ kind: "ask", subjectDocumentId: email });

    extract(email);
    settle(only(email), 0.2);
    expect(only(attachment)).toMatchObject({
      kind: "answered",
      subjectDocumentId: email,
      answer: { score: 0.2 },
    });
  });

  it("waits, with a backoff, for the email of an attachment that arrived first", () => {
    const attachment = seed("later/att", {
      documentType: "attachment",
      metadata: { extra: { parentExternalId: "later" } },
    });
    extract(attachment);
    const waiting = only(attachment);
    expect(waiting.kind).toBe("wait");
    applyMentionJudgements(
      db,
      [],
      [{ documentId: attachment, generation: waiting.generation, nextAttemptAt: 60_000 }],
    );
    expect(fetch(59_999)).toEqual([]);
    expect(fetch(60_000).map((p) => p.documentId)).toEqual([attachment]);
    // Once its email arrives it is judged by it.
    const email = seed("later");
    expect(fetch(60_000)[0]).toMatchObject({ kind: "ask", subjectDocumentId: email });
  });

  it("applies the answer the Brain's worth gate recorded for the same content and model", () => {
    const id = seed("a");
    extract(id);
    insertCognitionDecision(db, {
      id: "dec_1",
      runId: "run_1",
      documentId: id,
      subjectDocumentId: id,
      purpose: "worth-gate",
      lane: "data",
      rubricVersion: WORTH_GATE_RUBRIC_VERSION,
      contentHash: "hash-a",
      requestedModelId: MODEL,
      modelId: "jev-test-build-7",
      requestJson: null,
      responseJson: null,
      score: 2.4,
      threshold: 1.08,
      verdict: "pass",
      error: null,
      reusedFrom: null,
      recordId: null,
      enforced: true,
      latencyMs: 200,
      inputTokens: 900,
      createdAt: 1,
    });
    expect(fetch()[0]).toMatchObject({ kind: "answered", answer: { id: "dec_1", score: 2.4 } });
    // Another model's answer is not this model's.
    expect(fetch(0, "jev-other")[0]).toMatchObject({ kind: "ask" });
  });

  it("applies the email's stored answer across a rescan of unchanged content", () => {
    const id = seed("a");
    extract(id);
    settle(only(id), 0.4);
    expect(verdictOf(id)).toBe("drop");
    extract(id);
    expect(verdictOf(id)).toBe("pending");
    expect(only(id)).toMatchObject({ kind: "answered", answer: { score: 0.4 } });
    // New content asks again.
    seed("a", { hash: "hash-a-edited" });
    extract(id);
    expect(only(id)).toMatchObject({ kind: "ask" });
  });

  it("discards a verdict for content that changed while it was being asked", () => {
    const id = seed("a");
    extract(id);
    const inFlight = only(id);
    // The email is edited and rescanned before the answer comes back.
    seed("a", { hash: "hash-a-edited" });
    extract(id);
    expect(settle(inFlight, 0.1)).toBe(0);
    expect(verdictOf(id)).toBe("pending");
    expect(only(id)).toMatchObject({ kind: "ask", contentHash: "hash-a-edited" });
  });

  it("settles only a row that is still pending", () => {
    const id = seed("a");
    extract(id);
    const item = only(id);
    settle(item, 2);
    expect(verdictOf(id)).toBe("keep");
    // A late verdict for a judgement already settled changes nothing.
    expect(settle(item, 0.1)).toBe(0);
    expect(verdictOf(id)).toBe("keep");
  });

  it("requeues an attachment when its email is judged again for new content", () => {
    const email = seed("thread-2");
    const attachment = seed("thread-2/att", {
      documentType: "attachment",
      metadata: { extra: { parentExternalId: "thread-2" } },
    });
    extract(email);
    extract(attachment);
    settle(only(email), 0.2);
    settle(only(attachment));
    expect(verdictOf(attachment)).toBe("drop");

    seed("thread-2", { hash: "hash-thread-2-edited" });
    extract(email);
    settle(only(email), 2.5);
    expect(verdictOf(attachment)).toBe("pending");
    expect(only(attachment)).toMatchObject({ kind: "answered", answer: { score: 2.5 } });
  });

  it("requeues judgements made under another rubric version, a batch at a time", () => {
    const ids = ["a", "b", "c"].map((name) => seed(name));
    for (const id of ids) {
      extract(id);
      settle(only(id), 0.2);
    }
    expect(requeueStaleMentionJudgements(db, WORTH_GATE_RUBRIC_VERSION, 2)).toBe(0);
    expect(requeueStaleMentionJudgements(db, "email-worth-v2", 2)).toBe(2);
    expect(requeueStaleMentionJudgements(db, "email-worth-v2", 2)).toBe(1);
    expect(requeueStaleMentionJudgements(db, "email-worth-v2", 2)).toBe(0);
    expect(ids.map(verdictOf)).toEqual(["pending", "pending", "pending"]);
  });
});
