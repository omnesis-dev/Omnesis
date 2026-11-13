// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScopeFactsDocumentTriggers, createScopeFactsSchema } from "./scope-schema.js";
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

  it("writes nothing when the projection is the stored one", () => {
    db.exec(`CREATE TABLE fact_writes(n INTEGER);
      CREATE TRIGGER count_fact_insert AFTER INSERT ON document_scope_facts BEGIN INSERT INTO fact_writes VALUES(1); END;
      CREATE TRIGGER count_fact_delete AFTER DELETE ON document_scope_facts BEGIN INSERT INTO fact_writes VALUES(1); END;
      CREATE TRIGGER count_complete_insert AFTER INSERT ON document_scope_completeness BEGIN INSERT INTO fact_writes VALUES(1); END;
      CREATE TRIGGER count_complete_delete AFTER DELETE ON document_scope_completeness BEGIN INSERT INTO fact_writes VALUES(1); END;`);
    const writes = () => db.prepare("SELECT count(*) AS n FROM fact_writes").get();
    const email = (value: string) =>
      ({ kind: "participant", identifier: { type: "email", value } }) as const;
    const stored = {
      facts: [
        email("contact@example.org"),
        email("other@example.org"),
        { kind: "folder", id: "root" },
      ],
      complete: ["participant", "folder"],
    } satisfies Parameters<typeof replaceDocumentScopeFacts>[2];
    replaceDocumentScopeFacts(db, "doc", stored);
    // Two addresses share one domain fact.
    expect(writes()).toEqual({ n: 6 });

    replaceDocumentScopeFacts(db, "doc", {
      facts: [...stored.facts].reverse(),
      complete: ["folder", "participant"],
    });
    expect(writes()).toEqual({ n: 6 });

    replaceDocumentScopeFacts(db, "doc", { ...stored, complete: ["participant"] });
    expect(writes()).toEqual({ n: 17 });
    expect(db.prepare("SELECT kind FROM document_scope_completeness").all()).toEqual([
      { kind: "participant" },
    ]);
    replaceDocumentScopeFacts(db, "doc", {
      facts: stored.facts.slice(1),
      complete: ["participant"],
    });
    expect(
      db.prepare("SELECT entity_id FROM document_scope_facts ORDER BY entity_id").all(),
    ).toEqual([
      { entity_id: "domain:example.org" },
      { entity_id: "email:other@example.org" },
      { entity_id: "root" },
    ]);
  });

  it("leaves the source generation alone when the projection is the stored one", () => {
    db.exec(`ALTER TABLE documents ADD COLUMN source_id TEXT;
      UPDATE documents SET source_id='fictional:one';
      INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES('fictional:one','fictional','{}',1)`);
    createScopeFactsDocumentTriggers(db);
    const generation = () =>
      db.prepare("SELECT generation FROM scope_generation_clock WHERE id=1").get();
    const projection = {
      facts: [{ kind: "folder", id: "root" }],
      complete: ["folder"],
    } satisfies Parameters<typeof replaceDocumentScopeFacts>[2];
    replaceDocumentScopeFacts(db, "doc", projection);
    const written = generation();
    replaceDocumentScopeFacts(db, "doc", projection);
    expect(generation()).toEqual(written);
    replaceDocumentScopeFacts(db, "doc", { facts: [], complete: ["folder"] });
    expect(generation()).not.toEqual(written);
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
