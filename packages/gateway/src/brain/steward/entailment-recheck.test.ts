// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger, type EntailCapability } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createDocAnnotation, getDocAnnotation } from "../storage/annotations.js";
import { createPersonAnnotation, getPersonAnnotation } from "../storage/person-annotations.js";
import { buildAnnotationTools, type AnnotationToolDeps } from "./tools.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-06-01T12:00:00Z");
const EARLIER = NOW - 86_400_000;
const CTX = { sessionId: "recheck", messageId: "recheck" };
const QUOTE = "The observatory opens at nine on weekdays.";
const REWORDED = "The observatory opens at nine.";

let db: Database.Database;
let path: string;

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  db.prepare(
    `INSERT INTO people(id,canonical_name,source,first_seen,last_seen,created_at,updated_at)
     VALUES('person','fixture person','test',?,?,?,?)`,
  ).run(NOW, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,
       source_created_at,source_updated_at,ingested_at,updated_at)
     VALUES('source','test','test','source','Opening hours',?,'hash',?,?,?,?)`,
  ).run(QUOTE, NOW, NOW, NOW, NOW);
  const stamps = { verificationState: "verified" as const, lastVerifiedAt: EARLIER };
  createDocAnnotation(
    db,
    {
      id: "doc-note",
      docId: "source",
      claimType: "topic",
      claimText: QUOTE,
      evidenceDocId: "source",
      evidenceQuote: QUOTE,
      confidence: 0.8,
      claimBasis: "quoted",
      createdByRun: "seed",
      ...stamps,
    },
    EARLIER,
  );
  createPersonAnnotation(
    db,
    {
      id: "person-note",
      personId: "person",
      claimType: "role",
      claimText: QUOTE,
      evidenceDocId: "source",
      evidenceQuote: QUOTE,
      confidence: 0.8,
      claimBasis: "quoted",
      createdByRun: "seed",
      ...stamps,
    },
    EARLIER,
  );
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});

function tools(verify: EntailCapability["verify"], extra: Partial<AnnotationToolDeps> = {}) {
  const built = buildAnnotationTools({
    db,
    writeGate: directWriteGate(db),
    clock: () => NOW,
    runId: "recheck",
    log: createLogger("test:entailment-recheck"),
    getEntailmentVerifier: async () => ({ verify, dispose: () => {} }),
    ...extra,
  });
  const invoke = (name: string, args: unknown) =>
    built.find((t) => t.name === name)!.invoke(args, CTX);
  return async (name: string, args: unknown) => {
    // A person note can only be revised after reading that person's profile.
    if (name.startsWith("person_")) await invoke("annotation_search", { personId: "person" });
    return invoke(name, args);
  };
}
const noAnswer: EntailCapability["verify"] = async () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};
const stamps = (row: { verificationState: unknown; lastVerifiedAt: unknown } | null) => [
  row?.verificationState,
  row?.lastVerifiedAt,
];

describe("a revise whose check gets no answer", () => {
  test("keeps the verdict on an unchanged document note", async () => {
    const result = await tools(noAnswer)("annotation_revise", { id: "doc-note", confidence: 0.8 });

    expect(result).toMatchObject({ kind: "structured" });
    expect(stamps(getDocAnnotation(db, "doc-note"))).toEqual(["verified", EARLIER]);
  });

  test("keeps the verdict on an unchanged person note", async () => {
    const result = await tools(noAnswer)("person_annotation_revise", {
      id: "person-note",
      confidence: 0.8,
    });

    expect(result).toMatchObject({ kind: "structured" });
    expect(stamps(getPersonAnnotation(db, "person-note"))).toEqual(["verified", EARLIER]);
  });

  test("marks a reworded claim unverified, since the old verdict was for other words", async () => {
    const invoke = tools(noAnswer);

    await invoke("annotation_revise", { id: "doc-note", claimText: REWORDED });
    await invoke("person_annotation_revise", { id: "person-note", claimText: REWORDED });

    expect(stamps(getDocAnnotation(db, "doc-note"))).toEqual(["unverified", null]);
    expect(stamps(getPersonAnnotation(db, "person-note"))).toEqual(["unverified", null]);
  });

  test("a check that does answer still stamps the row", async () => {
    const verify: EntailCapability["verify"] = async () => ({
      label: "entailment",
      probability: 1,
    });

    await tools(verify)("annotation_revise", { id: "doc-note", confidence: 0.8 });

    expect(stamps(getDocAnnotation(db, "doc-note"))).toEqual(["verified", NOW]);
  });
});

describe("waiting for a verifier slot", () => {
  const answered = () =>
    vi.fn<EntailCapability["verify"]>(async () => ({ label: "entailment", probability: 1 }));

  test("is allowed for a background revise", async () => {
    const verify = answered();

    await tools(verify, { backgroundEntailmentRechecks: true })("annotation_revise", {
      id: "doc-note",
      confidence: 0.8,
    });

    expect(verify.mock.calls[0]?.[0].background).toEqual({
      queueWaitMs: 300_000,
      callMs: 45_000,
    });
  });

  test("is not allowed when someone may be waiting on an interactive revise", async () => {
    const verify = answered();

    await tools(verify)("annotation_revise", { id: "doc-note", confidence: 0.8 });

    expect(verify.mock.calls[0]?.[0].background).toBeUndefined();
  });
});
