// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { parseClaimMarkup } from "./claims.js";
import {
  advanceKnowledgeCascade,
  listKnowledgeNodes,
  listKnowledgeNodeRevisions,
  revalidateKnowledgeNode,
  createKnowledgeTables,
  saveKnowledgeNode,
  getKnowledgeNode,
  getKnowledgeClaims,
  getKnowledgeDependencies,
  registerKnowledgeEvidence,
  getKnowledgeEvidence,
  recordKnowledgeSourceChange,
  purgeKnowledgeBySource,
  listKnowledgeChanges,
  knowledgeClaimFingerprint,
} from "./storage.js";
import type { SaveKnowledgeNodeInput } from "./types.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT NOT NULL,content_hash TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO documents VALUES(?,?,?)").run(
    "schedule",
    "The workshop starts Friday.",
    "hash-one",
  );
  createKnowledgeTables(db);
});
afterEach(() => db.close());
function input(
  id = "project",
  overrides: Partial<SaveKnowledgeNodeInput> = {},
): SaveKnowledgeNodeInput {
  return {
    id,
    kind: "wiki",
    title: "Workshop",
    markdown: '<claim id="date" refs="source:schedule">The workshop starts Friday.</claim>',
    expectedRevision: 0,
    inputVersions: { "source:schedule": "hash-one" },
    ...overrides,
  };
}

describe("knowledge persistence", () => {
  it("atomically stores claims, stripped projection, dependencies and revision", () => {
    const saved = saveKnowledgeNode(db, input(), 10);
    expect(saved.node.revision).toBe(1);
    expect(saved.node.plainText).toBe("The workshop starts Friday.");
    expect(getKnowledgeClaims(db, "project")).toEqual([
      expect.objectContaining({
        id: "date",
        verification: "unverified",
        refs: ["source:schedule"],
      }),
    ]);
    expect(getKnowledgeDependencies(db, "project")[0]?.inputVersion).toBe("hash-one");
    expect(() => saveKnowledgeNode(db, input(), 11)).toThrow("Node revision changed");
    expect(getKnowledgeNode(db, "project")?.revision).toBe(1);
  });
  it("rejects changed source versions and rolls back every write", () => {
    saveKnowledgeNode(db, input(), 10);
    db.prepare("UPDATE documents SET content_hash='hash-two'").run();
    expect(() =>
      saveKnowledgeNode(db, input("project", { expectedRevision: 1, title: "Changed" }), 11),
    ).toThrow("Dependency revision changed");
    expect(getKnowledgeNode(db, "project")?.title).toBe("Workshop");
    expect(getKnowledgeClaims(db, "project")[0]?.text).toBe("The workshop starts Friday.");
  });
  it("accepts verifier attestations only for the exact text and dependency versions", () => {
    const proposed = input();
    const claim = parseClaimMarkup(proposed.markdown).claims[0]!;
    proposed.claims = [
      {
        id: "date",
        verification: {
          status: "verified",
          fingerprint: knowledgeClaimFingerprint(claim, proposed.inputVersions),
          verifier: "scripted-verifier",
        },
      },
    ];
    saveKnowledgeNode(db, proposed, 10);
    expect(getKnowledgeClaims(db, "project")[0]?.verification).toBe("verified");
    expect(() =>
      saveKnowledgeNode(
        db,
        {
          ...proposed,
          expectedRevision: 1,
          markdown: proposed.markdown.replace("Friday", "Saturday"),
        },
        11,
      ),
    ).toThrow("Verification does not match");
  });
  it("maintains singleton root and enforces its budget", () => {
    saveKnowledgeNode(db, input("root", { kind: "root" }), 10);
    expect(() => saveKnowledgeNode(db, input("other-root", { kind: "root" }), 11)).toThrow(
      "already has a root",
    );
    expect(() =>
      saveKnowledgeNode(
        db,
        input("root", { kind: "root", expectedRevision: 1, rootMaxChars: 5 }),
        12,
      ),
    ).toThrow("allowed budget is 5 characters");
  });
  it("validates specific claims and rejects circular support", () => {
    saveKnowledgeNode(db, input(), 10);
    saveKnowledgeNode(
      db,
      input("overview", {
        markdown: '<claim id="summary" refs="wiki:project#claim:date">Friday workshop.</claim>',
        inputVersions: { "wiki:project#claim:date": 1 },
      }),
      11,
    );
    expect(() =>
      saveKnowledgeNode(
        db,
        input("project", {
          expectedRevision: 1,
          markdown: '<claim id="date" refs="wiki:overview#claim:summary">Friday workshop.</claim>',
          inputVersions: { "wiki:overview#claim:summary": 1 },
        }),
        12,
      ),
    ).toThrow("Circular claim support");
    expect(() =>
      saveKnowledgeNode(
        db,
        input("bad", {
          markdown: '<claim id="summary" refs="wiki:project#claim:missing">Friday.</claim>',
          inputVersions: { "wiki:project#claim:missing": 1 },
        }),
        13,
      ),
    ).toThrow("Referenced claim");
  });
  it("allows navigation cycles without creating support cycles", () => {
    saveKnowledgeNode(db, input(), 10);
    saveKnowledgeNode(
      db,
      input("other", {
        markdown: '<claim id="link" refs="wiki:project">Related project.</claim>',
        inputVersions: { "wiki:project": 1 },
        claims: [{ id: "link", relations: { "wiki:project": "context" } }],
      }),
      11,
    );
    saveKnowledgeNode(
      db,
      input("project", {
        expectedRevision: 1,
        markdown: '<claim id="link" refs="wiki:other">Related project.</claim>',
        inputVersions: { "wiki:other": 1 },
        claims: [{ id: "link", relations: { "wiki:other": "context" } }],
      }),
      12,
    );
    expect(getKnowledgeNode(db, "project")?.revision).toBe(2);
  });
  it("requires canonical field existence and owner kind matching", () => {
    saveKnowledgeNode(
      db,
      input("loop-projection", {
        kind: "loop",
        ownerId: "task",
        canonicalFields: { state: "open" },
      }),
      10,
    );
    saveKnowledgeNode(
      db,
      input("project", {
        markdown: '<claim id="task" refs="loop:task#field:state">Work remains.</claim>',
        inputVersions: { "loop:task#field:state": 1 },
      }),
      11,
    );
    expect(() =>
      saveKnowledgeNode(
        db,
        input("wrong", {
          markdown: '<claim id="task" refs="wiki:task">Work remains.</claim>',
          inputVersions: { "wiki:task": 1 },
        }),
        12,
      ),
    ).toThrow("does not exist");
  });
  it("does not emit meaning changes for revision-only rewrites", () => {
    saveKnowledgeNode(db, input(), 10);
    const result = saveKnowledgeNode(
      db,
      input("project", { expectedRevision: 1, metadata: { importance: 0.8 } }),
      11,
    );
    expect(result.meaningChanged).toBe(false);
    expect(result.node.revision).toBe(2);
    expect(result.node.meaningRevision).toBe(1);
    expect(listKnowledgeChanges(db)).toHaveLength(1);
  });
});

describe("source revisions and privacy", () => {
  it("binds exact quoted passages to a source revision", () => {
    const evidence = registerKnowledgeEvidence(
      db,
      { documentId: "schedule", contentHash: "hash-one", quote: "starts Friday" },
      10,
    );
    expect(evidence.start).toBe(13);
    expect(getKnowledgeEvidence(db, evidence.id)).toEqual(evidence);
    const ref = `source:schedule#evidence:${evidence.id}`;
    saveKnowledgeNode(
      db,
      input("project", {
        markdown: `<claim id="date" refs="${ref}">Friday.</claim>`,
        inputVersions: { [ref]: "hash-one" },
      }),
      11,
    );
    expect(() =>
      registerKnowledgeEvidence(
        db,
        { documentId: "schedule", contentHash: "hash-one", quote: "Saturday" },
        12,
      ),
    ).toThrow("does not match");
    db.prepare("UPDATE documents SET content_hash='hash-two'").run();
    expect(getKnowledgeEvidence(db, evidence.id)).toBeNull();
    expect(() =>
      saveKnowledgeNode(
        db,
        input("other", {
          markdown: `<claim id="date" refs="${ref}">Friday.</claim>`,
          inputVersions: { [ref]: "hash-two" },
        }),
        13,
      ),
    ).toThrow("passage is missing or stale");
  });
  it("immediately invalidates transitive dependents, and repeated source events are idempotent", () => {
    recordKnowledgeSourceChange(db, { documentId: "schedule", contentHash: "hash-one" }, 9);
    saveKnowledgeNode(db, input(), 10);
    saveKnowledgeNode(
      db,
      input("overview", {
        markdown: '<claim id="summary" refs="wiki:project#claim:date">Friday workshop.</claim>',
        inputVersions: { "wiki:project#claim:date": 1 },
      }),
      11,
    );
    db.prepare("UPDATE documents SET content_hash='hash-two'").run();
    const update = recordKnowledgeSourceChange(
      db,
      { documentId: "schedule", contentHash: "hash-two" },
      12,
    );
    expect(update.affectedNodeIds.sort()).toEqual(["project"]);
    expect(getKnowledgeNode(db, "overview")?.validity).toBe("stale");
    expect(getKnowledgeClaims(db, "project")[0]?.verification).toBe("stale");
    expect(
      recordKnowledgeSourceChange(db, { documentId: "schedule", contentHash: "hash-two" }, 13)
        .changed,
    ).toBe(false);
    expect(getKnowledgeNode(db, "overview")?.revision).toBe(1);
  });
  it("purges the full derivative chain and refuses pending writes against a deleted source", () => {
    const evidence = registerKnowledgeEvidence(
      db,
      { documentId: "schedule", contentHash: "hash-one", quote: "Friday" },
      9,
    );
    saveKnowledgeNode(db, input(), 10);
    saveKnowledgeNode(
      db,
      input("overview", {
        markdown: '<claim id="summary" refs="wiki:project">Related workshop.</claim>',
        inputVersions: { "wiki:project": 1 },
        claims: [{ id: "summary", relations: { "wiki:project": "context" } }],
      }),
      11,
    );
    expect(purgeKnowledgeBySource(db, "schedule", 12).sort()).toEqual(["overview", "project"]);
    expect(getKnowledgeNode(db, "overview")).toBeNull();
    expect(getKnowledgeEvidence(db, evidence.id)).toBeNull();
    expect(listKnowledgeChanges(db).map((c) => c.kind)).toEqual([
      "node_deleted",
      "node_deleted",
      "source_deleted",
    ]);
    expect(() => saveKnowledgeNode(db, input(), 13)).toThrow("cannot be reused");
    expect(
      recordKnowledgeSourceChange(db, { documentId: "schedule", contentHash: "hash-one" }, 14)
        .changed,
    ).toBe(false);
  });
});

describe("bounded cascade recovery", () => {
  it("fences every affected read before cleanup and resumes a persisted frontier", () => {
    for (let index = 0; index < 130; index++)
      saveKnowledgeNode(db, input(`page-${String(index).padStart(3, "0")}`), 10);
    purgeKnowledgeBySource(db, "schedule", 20);
    expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_nodes").get()).toEqual({
      count: 130,
    });
    expect(getKnowledgeNode(db, "page-129")).toBeNull();
    expect(getKnowledgeClaims(db, "page-129")).toEqual([]);
    expect(listKnowledgeNodes(db)).toEqual([]);
    expect(() =>
      saveKnowledgeNode(
        db,
        input("page-129", {
          expectedRevision: 1,
          markdown: "Removed references.",
          inputVersions: {},
        }),
        21,
      ),
    ).toThrow("pending privacy deletion");
    const image = db.serialize();
    db.close();
    db = new Database(image);
    db.pragma("foreign_keys=ON");
    let pending = true;
    let chunks = 0;
    let deleted = 0;
    while (pending && chunks++ < 40) {
      const result = advanceKnowledgeCascade(db, 13, 30 + chunks);
      expect(result.deletedNodeIds.length).toBeLessThanOrEqual(13);
      deleted += result.deletedNodeIds.length;
      pending = result.pending;
    }
    expect(pending).toBe(false);
    expect(deleted).toBe(130);
    expect(() =>
      saveKnowledgeNode(db, input("page-129", { markdown: "Replacement.", inputVersions: {} }), 99),
    ).toThrow("cannot be reused");
  });
  it("reports pending support loss as stale before bounded physical invalidation reaches it", () => {
    for (let index = 0; index < 130; index++) saveKnowledgeNode(db, input(`page-${index}`), 10);
    db.prepare("UPDATE documents SET content_hash='hash-two'").run();
    recordKnowledgeSourceChange(db, { documentId: "schedule", contentHash: "hash-two" }, 20);
    expect(getKnowledgeNode(db, "page-129")?.validity).toBe("stale");
    expect(getKnowledgeClaims(db, "page-129")[0]?.verification).toBe("stale");
  });
});

it("permits mutually linked pages when their claim support graph is acyclic", () => {
  saveKnowledgeNode(db, input(), 10);
  saveKnowledgeNode(
    db,
    input("other", {
      markdown:
        '<claim id="source-fact" refs="source:schedule">Friday.</claim> <claim id="related" refs="wiki:project#claim:date">Workshop date.</claim>',
      inputVersions: { "source:schedule": "hash-one", "wiki:project#claim:date": 1 },
    }),
    11,
  );
  saveKnowledgeNode(
    db,
    input("project", {
      expectedRevision: 1,
      markdown:
        '<claim id="date" refs="source:schedule">Friday.</claim> <claim id="related" refs="wiki:other#claim:source-fact">Workshop date.</claim>',
      inputVersions: { "source:schedule": "hash-one", "wiki:other#claim:source-fact": 1 },
    }),
    12,
  );
  expect(getKnowledgeClaims(db, "project")).toHaveLength(2);
});

it("retains immutable revisions with claim/field/ref diffs and strips histories on privacy deletion", () => {
  saveKnowledgeNode(db, input(), 10);
  saveKnowledgeNode(
    db,
    input("project", {
      expectedRevision: 1,
      title: "Workshop preparation",
      canonicalFields: { phase: "planned" },
    }),
    11,
  );
  const revisions = listKnowledgeNodeRevisions(db, "project");
  expect(revisions.map((r) => r.revision)).toEqual([2, 1]);
  expect(revisions[0]?.diff).toMatchObject({
    changedClaimIds: [],
    changedFieldKeys: ["phase"],
    titleChanged: true,
  });
  expect(revisions[1]?.title).toBe("Workshop");
  expect(listKnowledgeNodeRevisions(db, "project", { beforeRevision: 2, limit: 1 })).toHaveLength(
    1,
  );
  // The current page no longer cites this source; retained history still does.
  saveKnowledgeNode(
    db,
    input("project", {
      expectedRevision: 2,
      markdown: "Workshop reference page.",
      inputVersions: {},
    }),
    12,
  );
  purgeKnowledgeBySource(db, "schedule", 13);
  expect(getKnowledgeNode(db, "project")).toBeNull();
  expect(listKnowledgeNodeRevisions(db, "project")).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_revisions").get()).toEqual({
    count: 0,
  });
});

it("relevance-gate revalidation does not invent verification or propagate unchanged prose", () => {
  const proposed = input();
  proposed.claims = [
    {
      id: "date",
      verification: {
        status: "verified",
        fingerprint: knowledgeClaimFingerprint(
          parseClaimMarkup(proposed.markdown).claims[0]!,
          proposed.inputVersions,
        ),
        verifier: "scripted",
      },
    },
  ];
  saveKnowledgeNode(db, proposed, 10);
  db.prepare("UPDATE documents SET content_hash='hash-two'").run();
  recordKnowledgeSourceChange(db, { documentId: "schedule", contentHash: "hash-two" }, 11);
  const result = revalidateKnowledgeNode(
    db,
    { id: "project", expectedRevision: 2, inputVersions: { "source:schedule": "hash-two" } },
    12,
  );
  expect(result.meaningChanged).toBe(false);
  expect(result.node.validity).toBe("current");
  expect(getKnowledgeClaims(db, "project")[0]?.verification).toBe("unverified");
});

it("clears projected descendant staleness after an unchanged verified parent repair without revisiting the descendant", () => {
  const parent = input();
  const tagged = parseClaimMarkup(parent.markdown).claims[0]!;
  parent.claims = [
    {
      id: "date",
      verification: {
        status: "verified",
        fingerprint: knowledgeClaimFingerprint(tagged, parent.inputVersions),
        verifier: "scripted",
      },
    },
  ];
  saveKnowledgeNode(db, parent, 10);
  const child = input("overview", {
    markdown: '<claim id="summary" refs="wiki:project#claim:date">Friday workshop.</claim>',
    inputVersions: { "wiki:project#claim:date": 1 },
  });
  child.claims = [
    {
      id: "summary",
      verification: {
        status: "verified",
        fingerprint: knowledgeClaimFingerprint(
          parseClaimMarkup(child.markdown).claims[0]!,
          child.inputVersions,
        ),
        verifier: "scripted",
      },
    },
  ];
  saveKnowledgeNode(db, child, 11);
  db.prepare(
    "UPDATE documents SET content_hash='hash-two',content='The workshop starts Friday. Bring a notebook.'",
  ).run();
  recordKnowledgeSourceChange(db, { documentId: "schedule", contentHash: "hash-two" }, 12);
  expect(getKnowledgeNode(db, "overview")?.validity).toBe("stale");
  expect(db.prepare("SELECT validity FROM knowledge_nodes WHERE id='overview'").get()).toEqual({
    validity: "current",
  });
  const updatedVersions = { "source:schedule": "hash-two" };
  const repaired = saveKnowledgeNode(
    db,
    {
      ...parent,
      expectedRevision: 2,
      inputVersions: updatedVersions,
      claims: [
        {
          id: "date",
          verification: {
            status: "verified",
            fingerprint: knowledgeClaimFingerprint(tagged, updatedVersions),
            verifier: "scripted",
          },
        },
      ],
    },
    13,
  );
  expect(repaired.meaningChanged).toBe(false);
  expect(repaired.node.meaningRevision).toBe(1);
  expect(repaired.node.revision).toBe(3);
  expect(getKnowledgeNode(db, "overview")).toMatchObject({ validity: "current", revision: 1 });
  expect(getKnowledgeClaims(db, "overview")[0]?.verification).toBe("verified");
  expect(getKnowledgeDependencies(db, "overview")[0]?.inputVersion).toBe(1);
});
