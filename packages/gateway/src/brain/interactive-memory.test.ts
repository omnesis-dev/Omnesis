// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID, createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger, type EntailCapability } from "@omnesis/core";
import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import { EventBus } from "../events.js";
import { validateConversationAnnotationEvidence } from "../sources/omnesis-chat/memory-evidence.js";
import { resolveBrainSettings } from "./config.js";
import {
  createInteractiveMemoryProfile,
  subscribeMemoryInvalidators,
} from "./interactive-memory.js";
import { listLiveAnnotationsForDoc } from "./storage/annotations.js";
import { listLivePersonAnnotationsForPerson } from "./storage/person-annotations.js";
import type Database from "better-sqlite3";
import type { ConversationRecord } from "../agent/conversation-store.js";

const log = createLogger("test:interactive-memory");
const quote = "I prefer meetings in the morning.";
const context = { sessionId: "session", messageId: "message" };
const now = Date.parse("2026-01-01T12:00:00Z");
let db: Database.Database;
let path: string;

beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  vi.stubEnv("OMNESIS_SYNTHETIC", "0");
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
       source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES ('doc', 'test', 'test', 'doc', 'Preference', ?, ?, ?, ?, ?, ?)`,
  ).run(quote, createHash("sha256").update(quote).digest("hex"), now, now, now, now);
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES ('self', 'Maya Reeves', 'test', 1, ?, ?, ?, ?)`,
  ).run(now, now, now, now);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
  vi.unstubAllEnvs();
});

function profile(verifier: EntailCapability | null = null) {
  return createInteractiveMemoryProfile({
    db,
    writeGate: directWriteGate(db),
    getSettings: () => resolveBrainSettings({ annotations: { enabled: false } }),
    getEntailmentVerifier: () => Promise.resolve(verifier),
    clock: () => now,
    log,
  });
}

const claim = {
  claimType: "meeting-preference",
  claimText: "The user prefers morning meetings.",
  evidenceDocId: "doc",
  evidenceQuote: quote,
  claimBasis: "quoted",
  confidence: 0.8,
};

describe("interactive memory without background cognition", () => {
  test("writes document and self memory with automation disabled and keeps evidence checks", async () => {
    const tools = profile().buildOwnTools("interactive_session");
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "annotate_durable",
      "annotate_person",
      "annotation_retract",
      "annotation_revise",
      "annotation_search",
      "annotation_supersede",
      "person_annotation_retract",
      "person_annotation_revise",
      "person_annotation_supersede",
    ]);
    const documentTool = tools.find((tool) => tool.name === "annotate_durable")!;
    const personTool = tools.find((tool) => tool.name === "annotate_person")!;
    expect(await documentTool.invoke({ ...claim, docId: "doc" }, context)).toMatchObject({
      kind: "structured",
      resultType: "annotation.created",
    });
    expect(await personTool.invoke({ ...claim, personId: "self" }, context)).toMatchObject({
      kind: "structured",
      resultType: "person_annotation.created",
    });
    expect(listLiveAnnotationsForDoc(db, "doc")).toHaveLength(1);
    expect(listLivePersonAnnotationsForPerson(db, "self")).toHaveLength(1);
    expect(
      await documentTool.invoke(
        {
          ...claim,
          docId: "doc",
          evidenceQuote: "This quote was never in the document.",
        },
        context,
      ),
    ).toMatchObject({ kind: "error", code: "evidence_not_found" });
  });

  test("retains the configured semantic verifier in stable mode", async () => {
    const verify = vi.fn(() => Promise.resolve({ label: "neutral" as const }));
    const tool = profile({ verify, dispose() {} })
      .buildOwnTools("interactive_session")
      .find((tool) => tool.name === "annotate_person")!;
    expect(await tool.invoke({ ...claim, personId: "self" }, context)).toMatchObject({
      kind: "error",
      code: "evidence_does_not_entail_claim",
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(listLivePersonAnnotationsForPerson(db, "self")).toEqual([]);
  });

  test("new toolsets use changed confidence settings and enforce source evidence validation", async () => {
    let confidenceCeiling = 0.4;
    const validateAnnotationEvidence = vi.fn(() => Promise.resolve(null));
    const memory = createInteractiveMemoryProfile({
      db,
      writeGate: directWriteGate(db),
      getSettings: () => ({
        ...resolveBrainSettings(),
        annotationConfidenceCeiling: confidenceCeiling,
      }),
      validateAnnotationEvidence,
      clock: () => now,
      log,
    });
    const docTool = memory
      .buildOwnTools("interactive_first")
      .find((tool) => tool.name === "annotate_durable")!;
    await docTool.invoke({ ...claim, docId: "doc" }, context);
    expect(listLiveAnnotationsForDoc(db, "doc")[0]?.confidence).toBe(0.4);
    confidenceCeiling = 0.6;
    const personTool = memory
      .buildOwnTools("interactive_second")
      .find((tool) => tool.name === "annotate_person")!;
    await personTool.invoke({ ...claim, personId: "self" }, context);
    expect(listLivePersonAnnotationsForPerson(db, "self")[0]?.confidence).toBe(0.6);
    expect(validateAnnotationEvidence).toHaveBeenCalledWith("doc", quote);
  });

  test.each(["primary", "additional"] as const)(
    "cannot revise legacy assistant testimony in the %s evidence atom",
    async (position) => {
      const assistantQuote = "The user owns a purple sailing boat.";
      const content = `${quote}\n\n${assistantQuote}`;
      db.prepare(
        "UPDATE documents SET provider_id = 'system', source_id = 'omnesis-chat', external_id = 'conversation', content = ?, content_hash = ? WHERE id = 'doc'",
      ).run(content, createHash("sha256").update(content).digest("hex"));
      const legacyClaim = {
        ...claim,
        evidenceQuote: position === "primary" ? assistantQuote : quote,
        ...(position === "additional"
          ? { additionalEvidence: [{ docId: "doc", quote: assistantQuote }] }
          : {}),
      };
      // These rows model annotations predating authenticated speaker checks.
      const legacyTools = profile().buildOwnTools("legacy_run");
      await legacyTools
        .find((tool) => tool.name === "annotate_durable")!
        .invoke({ ...legacyClaim, docId: "doc" }, context);
      await legacyTools
        .find((tool) => tool.name === "annotate_person")!
        .invoke({ ...legacyClaim, personId: "self" }, context);
      const document = listLiveAnnotationsForDoc(db, "doc")[0]!;
      const person = listLivePersonAnnotationsForPerson(db, "self")[0]!;
      const record: ConversationRecord = {
        id: "conversation",
        callerId: "fixture",
        model: "replay",
        backend: "replay",
        title: "Conversation",
        pinned: false,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        messages: [
          { role: "user", parts: [{ kind: "text", text: quote }] },
          { role: "assistant", parts: [{ kind: "text", text: assistantQuote }] },
        ],
      };
      const tools = createInteractiveMemoryProfile({
        db,
        writeGate: directWriteGate(db),
        getSettings: () => resolveBrainSettings(),
        clock: () => now,
        log,
        validateAnnotationEvidence: (docId, text) =>
          validateConversationAnnotationEvidence(
            { readDb: db, loadConversation: async () => record },
            docId,
            text,
          ),
      }).buildOwnTools("interactive_session");
      for (const [name, id] of [
        ["annotation_revise", document.id],
        ["person_annotation_revise", person.id],
      ]) {
        const result = await tools
          .find((tool) => tool.name === name)!
          .invoke({ id, claimText: "A revision must not launder assistant testimony." }, context);
        expect(result).toMatchObject({ kind: "error", code: "invalid_evidence" });
      }
      expect(listLiveAnnotationsForDoc(db, "doc")[0]?.claimText).toBe(claim.claimText);
      expect(listLivePersonAnnotationsForPerson(db, "self")[0]?.claimText).toBe(claim.claimText);
    },
  );

  test("invalidates both stores when evidence changes while Brain is disabled", async () => {
    for (const tool of profile().buildOwnTools("interactive_session")) {
      if (tool.name === "annotate_durable") await tool.invoke({ ...claim, docId: "doc" }, context);
      if (tool.name === "annotate_person")
        await tool.invoke({ ...claim, personId: "self" }, context);
    }
    const eventBus = new EventBus();
    const unsubscribe = subscribeMemoryInvalidators({
      db,
      writeGate: directWriteGate(db),
      eventBus,
      clock: () => now + 1,
      log,
    });
    db.prepare(
      "UPDATE documents SET content = 'The preference was removed.', content_hash = 'new' WHERE id = 'doc'",
    ).run();
    eventBus.emit("document.upserted", {
      before: null,
      after: {
        id: "doc",
        providerId: "test",
        sourceId: "test",
        externalId: "doc",
        documentType: "file",
        title: "Preference",
        contentHash: "new",
        metadata: {},
        sourceCreatedAt: new Date(now).toISOString(),
        sourceUpdatedAt: new Date(now + 1).toISOString(),
        people: [],
      },
      afterContent: "The preference was removed.",
      changedFields: ["contentHash"],
      contentChanged: true,
    });
    await vi.waitFor(() => {
      expect(listLiveAnnotationsForDoc(db, "doc")).toEqual([]);
      expect(listLivePersonAnnotationsForPerson(db, "self")).toEqual([]);
    });
    expect(db.prepare("SELECT count(*) AS n FROM cognition_runs").get()).toEqual({ n: 0 });
    unsubscribe();
  });
});
