// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  assertKnowledgeDiscoveryComplete,
  requiredKnowledgeDiscoveryPhases,
} from "./discovery-completion.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
import { fitKnowledgeFrontierItem } from "./engine-frontier.js";
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    `CREATE TABLE knowledge_discovery_coverage(subject_id TEXT,input_revision TEXT,policy_version TEXT,phase TEXT,status TEXT,reconsider_at INTEGER)`,
  );
});
afterEach(() => db.close());

it.each(["considered", "gated"])(
  "reports only uncovered current phases after %s coverage",
  (status) => {
    expect(requiredKnowledgeDiscoveryPhases(db, "source", "v1", 100)).toEqual([
      "interpretation",
      "organization",
    ]);
    db.prepare("INSERT INTO knowledge_discovery_coverage VALUES(?,?,?,?,?,?)").run(
      "source",
      "v1",
      KNOWLEDGE_DISCOVERY_POLICY,
      "interpretation",
      status,
      101,
    );
    expect(requiredKnowledgeDiscoveryPhases(db, "source", "v1", 100)).toEqual(["organization"]);
    expect(() =>
      assertKnowledgeDiscoveryComplete(db, "source", "v1", ["interpretation"], 100),
    ).toThrow("organization still requires review");
    expect(() =>
      assertKnowledgeDiscoveryComplete(db, "source", "v1", ["organization"], 100),
    ).not.toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM knowledge_discovery_coverage").get()).toEqual({
      n: 1,
    });
  },
);

it.each([
  ["source", "v1", KNOWLEDGE_DISCOVERY_POLICY, "considered", 100],
  ["other", "v1", KNOWLEDGE_DISCOVERY_POLICY, "considered", null],
  ["source", "v0", KNOWLEDGE_DISCOVERY_POLICY, "considered", null],
  ["source", "v1", "old-policy", "considered", null],
  ["source", "v1", KNOWLEDGE_DISCOVERY_POLICY, "pending", null],
])("does not borrow ineligible coverage %j", (subject, revision, policy, status, reconsider) => {
  db.prepare("INSERT INTO knowledge_discovery_coverage VALUES(?,?,?,?,?,?)").run(
    subject,
    revision,
    policy,
    "interpretation",
    status,
    reconsider,
  );
  expect(requiredKnowledgeDiscoveryPhases(db, "source", "v1", 100)).toEqual([
    "interpretation",
    "organization",
  ]);
});

it("preserves explicit review obligations in compact source offers without adding coverage", () => {
  const compact = fitKnowledgeFrontierItem(
    {
      id: "source:source",
      inputFingerprint: "fingerprint",
      pendingClaimIds: [],
      inputVersions: { "source:source": "v1" },
      depth: 0,
      completionRequirements: { requiredPhases: ["interpretation", "organization"] },
      source: {
        id: "source",
        title: "Laboratory notes",
        content: "Observation. ".repeat(1000),
        contentHash: "v1",
        sourceRevision: "v1",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
      },
    },
    1800,
    true,
  );
  expect(compact).toMatchObject({
    fetchRequired: { kind: "source" },
    inputVersionsOmitted: true,
    completionRequirements: { requiredPhases: ["interpretation", "organization"] },
  });
  expect(() =>
    assertKnowledgeDiscoveryComplete(db, "source", "v1", ["interpretation"], 100),
  ).toThrow();
  expect(() =>
    assertKnowledgeDiscoveryComplete(db, "source", "v1", ["interpretation", "organization"], 100),
  ).not.toThrow();
});

it("allows empty phases only while both current coverage receipts remain eligible", () => {
  const insert = db.prepare("INSERT INTO knowledge_discovery_coverage VALUES(?,?,?,?,?,?)");
  for (const phase of ["interpretation", "organization"])
    insert.run("source", "v1", KNOWLEDGE_DISCOVERY_POLICY, phase, "considered", 101);
  expect(requiredKnowledgeDiscoveryPhases(db, "source", "v1", 100)).toEqual([]);
  expect(() => assertKnowledgeDiscoveryComplete(db, "source", "v1", [], 100)).not.toThrow();
  expect(() => assertKnowledgeDiscoveryComplete(db, "source", "v2", [], 100)).toThrow(
    "still requires review",
  );
  expect(() => assertKnowledgeDiscoveryComplete(db, "source", "v1", [], 101)).toThrow(
    "still requires review",
  );
  db.prepare("DELETE FROM knowledge_discovery_coverage WHERE phase='organization'").run();
  expect(() => assertKnowledgeDiscoveryComplete(db, "source", "v1", [], 100)).toThrow(
    "organization still requires review",
  );
});
