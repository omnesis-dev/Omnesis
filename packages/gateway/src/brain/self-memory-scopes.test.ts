// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db.js";
import { createCorpusAuthorization } from "../access/corpus-authorization.js";
import { replaceDocumentScopeFacts } from "../access/scope-facts.js";
import {
  createPersonAnnotation,
  DEFAULT_SELF_MEMORY_MAX_ANNOTATIONS,
} from "./storage/person-annotations.js";
import { resolveSelfMemory } from "./self-memory.js";
import type Database from "better-sqlite3";

describe("external self memory evidence boundaries", () => {
  let db: Database.Database;
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omnesis-scoped-memory-"));
    db = createDatabase(join(directory, "corpus.db"));
    db.exec(`INSERT INTO devices (id,name,kind,paired_at) VALUES ('00000000-0000-4000-8000-000000000001','Synthetic collector','collector',1);
      INSERT INTO sources (id,type,account_id,device_id,created_at,updated_at)
        VALUES ('fictional:one','fictional','one','00000000-0000-4000-8000-000000000001',1,1);
      INSERT INTO scope_fact_backfill (source_id,source_type,descriptor_json,ready) VALUES ('fictional:one','fictional','{}',1);
      INSERT INTO people (id,canonical_name,source,is_self,first_seen,last_seen,created_at,updated_at)
        VALUES ('self','Synthetic owner','test',1,'2026-01-01','2026-01-01','2026-01-01','2026-01-01');`);
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function document(id: string, conversation?: string) {
    db.prepare(
      `INSERT INTO documents (id,provider_id,source_id,external_id,title,content,content_hash,metadata,
      source_created_at,source_updated_at,ingested_at,updated_at) VALUES (?, 'fictional','fictional:one',?,?,'Fictional evidence.','hash','{}','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
    ).run(id, id, id);
    if (conversation)
      replaceDocumentScopeFacts(db, id, {
        facts: [{ kind: "conversation", id: conversation }],
        complete: ["conversation"],
      });
  }
  function fact(id: string, evidenceDocId: string, now: number, extra?: string) {
    createPersonAnnotation(
      db,
      {
        id,
        personId: "self",
        claimType: "preference",
        claimText: `Fictional fact ${id}`,
        evidenceDocId,
        evidenceQuote: "Fictional evidence.",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "test",
        ...(extra ? { additionalEvidence: [{ docId: extra, quote: "Fictional evidence." }] } : {}),
      },
      now,
      { maxFacts: DEFAULT_SELF_MEMORY_MAX_ANNOTATIONS + 10, maxCharacters: 100_000 },
    );
  }
  function authorization(
    action: "share" | "hide" = "share",
    sourceMode: "all" | "allowlist" = "all",
  ) {
    return createCorpusAuthorization(
      {
        principalId: "principal",
        grantId: "grant",
        grantRevision: 1,
        credentialId: "credential",
        accessTokenId: "token",
      },
      [
        {
          capability: "answer",
          sourceMode,
          sourceIds: sourceMode === "all" ? [] : ["fictional:one"],
          releaseMode: "unreviewed",
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
          filterRevision: 1,
          scopePolicies: [
            {
              sourceId: "fictional:one",
              audience: { accessLevel: "level", capability: "answer" },
              rules: [{ action, match: [{ kind: "conversation", id: "selected" }] }],
              otherwise: action === "share" ? "hide" : "share",
            },
          ],
        },
      ],
      "answer",
    )!;
  }

  it.each(["share", "hide"] as const)(
    "filters self facts under %s mode and hides unknown evidence",
    (action) => {
      document("selected", "selected");
      document("other", "other");
      document("unknown");
      fact("selected-fact", "selected", 1);
      fact("other-fact", "other", 2);
      fact("unknown-fact", "unknown", 3);
      const result = resolveSelfMemory(db, true, authorization(action));
      expect(result.annotationIds).toEqual([action === "share" ? "selected-fact" : "other-fact"]);
      expect(result.selfMemory).not.toContain("unknown-fact");
      expect(resolveSelfMemory(db, true).annotationIds).toHaveLength(3);
    },
  );

  it("requires every live evidence atom of a blended fact to be visible", () => {
    document("allowed", "selected");
    document("denied", "other");
    fact("blended", "allowed", 1, "denied");
    fact("allowed-only", "allowed", 2);
    expect(resolveSelfMemory(db, true, authorization()).annotationIds).toEqual(["allowed-only"]);
    db.prepare("DELETE FROM documents WHERE id = ?").run("denied");
    expect(resolveSelfMemory(db, true, authorization()).annotationIds).toEqual(["allowed-only"]);
  });

  it("captures every grounding document of rendered facts in the same snapshot", () => {
    document("primary", "selected");
    document("secondary", "selected");
    document("hidden", "other");
    fact("visible-multi", "primary", 1, "secondary");
    fact("hidden-single", "hidden", 2);
    const memory = resolveSelfMemory(db, true, authorization());
    expect(memory.annotationIds).toEqual(["visible-multi"]);
    expect([...memory.evidenceDocumentIds!].sort()).toEqual(["primary", "secondary"]);
  });

  it("applies evidence authorization before the self memory cap", () => {
    document("allowed", "selected");
    document("denied", "other");
    fact("older-allowed", "allowed", 1);
    for (let i = 0; i < DEFAULT_SELF_MEMORY_MAX_ANNOTATIONS + 1; i++)
      fact(`recent-hidden-${i}`, "denied", i + 2);
    expect(resolveSelfMemory(db, true, authorization()).annotationIds).toEqual(["older-allowed"]);
  });

  it("still applies an explicit whole-source allowlist to evidence", () => {
    document("allowed", "selected");
    fact("visible", "allowed", 1);
    db.prepare("UPDATE documents SET source_id = ? WHERE id = ?").run("unconfigured", "allowed");
    expect(resolveSelfMemory(db, true, authorization("share", "allowlist")).annotationIds).toEqual(
      [],
    );
    // Adding a filter to an all-sources grant does not remove another source.
    expect(resolveSelfMemory(db, true, authorization()).annotationIds).toEqual(["visible"]);
  });
});
