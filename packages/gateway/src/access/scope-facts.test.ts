// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScopeFactsSchema } from "./scope-schema.js";
import {
  deleteDocumentScopeFacts,
  invalidateDocumentScopeKind,
  replaceDocumentScopeFacts,
} from "./scope-facts.js";
import { scopePolicySql } from "./scope-sql.js";
import type { ScopePolicy } from "@omnesis/types";

describe("document scope fact replacement", () => {
  let db: Database.Database;
  const filter: ScopePolicy = {
    sourceId: "fictional:one",
    audience: { accessLevel: "level", capability: "direct" },
    rules: [
      {
        action: "share",
        match: [
          {
            kind: "participant",
            label: "Domain",
            identifiers: [{ type: "domain", value: "example.org" }],
          },
        ],
      },
    ],
    otherwise: "hide",
  };
  beforeEach(() => {
    db = new Database(":memory:");
    createScopeFactsSchema(db);
    db.exec("CREATE TABLE documents(id TEXT); INSERT INTO documents VALUES ('doc')");
  });
  afterEach(() => db.close());
  function allowed(): boolean {
    const decision = scopePolicySql(filter, "d.id");
    return (
      db.prepare(`SELECT 1 FROM documents d WHERE ${decision.sql}`).get(...decision.params) !==
      undefined
    );
  }

  it("derives exact domains from native email facts", () => {
    replaceDocumentScopeFacts(db, "doc", {
      facts: [
        {
          kind: "participant",
          identifier: {
            type: "email",
            value: "contact@example.org",
          },
        },
      ],
      complete: ["participant"],
    });
    expect(allowed()).toBe(true);
    replaceDocumentScopeFacts(db, "doc", {
      facts: [
        {
          kind: "participant",
          identifier: {
            type: "email",
            value: "contact@sub.example.org",
          },
        },
      ],
      complete: ["participant"],
    });
    expect(allowed()).toBe(false);
  });

  it("clears previous completeness when a new projection is unresolved", () => {
    const facts = [
      {
        kind: "participant" as const,
        identifier: {
          type: "email" as const,
          value: "contact@example.org",
        },
      },
    ];
    replaceDocumentScopeFacts(db, "doc", { facts, complete: ["participant"] });
    expect(allowed()).toBe(true);
    replaceDocumentScopeFacts(db, "doc", { facts, complete: [] });
    expect(allowed()).toBe(false);
    replaceDocumentScopeFacts(db, "doc", { facts, complete: ["participant"] });
    invalidateDocumentScopeKind(db, "doc", "participant");
    expect(allowed()).toBe(false);
  });

  it("rolls facts and completeness back with the caller's document transaction", () => {
    expect(() =>
      db.transaction(() => {
        replaceDocumentScopeFacts(db, "doc", { facts: [], complete: ["participant"] });
        throw new Error("interrupted");
      })(),
    ).toThrow(/interrupted/);
    expect(db.prepare("SELECT * FROM document_scope_completeness").all()).toEqual([]);
  });

  it("removes all facts and completeness on document deletion", () => {
    replaceDocumentScopeFacts(db, "doc", {
      facts: [{ kind: "folder", id: "root" }],
      complete: ["folder"],
    });
    deleteDocumentScopeFacts(db, "doc");
    expect(db.prepare("SELECT * FROM document_scope_facts").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM document_scope_completeness").all()).toEqual([]);
  });
});
