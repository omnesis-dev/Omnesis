// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, it, expect } from "vitest";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createAnnotationStorageTables } from "../storage/annotations.js";
import { createPersonAnnotationStorageTables } from "../storage/person-annotations.js";
import { listRetiredLoops } from "../storage/retired-loops.js";
import {
  createOpenLoop,
  getOpenLoop,
  deleteOpenLoop,
  updateOpenLoop,
} from "../storage/open-loops.js";
import { createBrief, getBrief, updateBrief, setBriefState } from "../storage/briefs.js";
import {
  createKnowledgeTables,
  getKnowledgeNode,
  getKnowledgeClaims,
  getKnowledgeDependencies,
  purgeKnowledgeBySource,
  advanceKnowledgeCascade,
  saveKnowledgeNode,
} from "./storage.js";
import {
  convertKnowledgeOwner,
  readKnowledgeOwner,
  saveOwnedKnowledgeNode,
} from "./owner-adapters.js";
import { withdrawKnowledgeOwner } from "./owner-withdrawal.js";
import { installKnowledgeOwnerTriggers } from "./owner-triggers.js";
import { advanceKnowledgeOwnerSync } from "./owner-sync.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,provider_id TEXT,source_id TEXT,external_id TEXT,content TEXT,content_hash TEXT)",
  );
  db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?)").run(
    "evidence",
    "test",
    "notes",
    "workshop",
    "Workshop Friday.",
    "v1",
  );
  createBriefsStorageTables(db);
  createAnnotationStorageTables(db);
  createPersonAnnotationStorageTables(db);
  createKnowledgeTables(db);
});
afterEach(() => db.close());
function loop() {
  return createOpenLoop(
    db,
    {
      id: "task",
      createdByRun: "run",
      title: "Prepare workshop",
      description: "Workshop Friday.",
      state: "done",
      confidence: 0.7,
      importance: 0.5,
      docs: ["evidence"],
    },
    1,
  );
}
it("converts closed loops without reopening or inventing verified support", () => {
  loop();
  const result = convertKnowledgeOwner(db, "loop", "task", 2);
  expect(result.node.canonicalFields.state).toBe("done");
  expect(getOpenLoop(db, "task")?.state).toBe("done");
  expect(getKnowledgeClaims(db, "task")[0]?.verification).toBe("unverified");
  expect(getKnowledgeDependencies(db, "task")[0]?.relation).toBe("context");
  expect(convertKnowledgeOwner(db, "loop", "task", 3).node.revision).toBe(1);
});
it("owner saves preserve operational fields, strip only the legacy prose projection, and reject owner races", () => {
  loop();
  convertKnowledgeOwner(db, "loop", "task", 2);
  const owner = readKnowledgeOwner(db, "loop", "task");
  const proposed = {
    id: "task",
    ownerId: "task",
    kind: "loop" as const,
    title: owner.title,
    markdown: '<claim id="date" refs="source:evidence">Workshop Friday.</claim>',
    expectedRevision: 1,
    inputVersions: { "source:evidence": "v1" },
    canonicalFields: { state: "open" },
  };
  saveOwnedKnowledgeNode(db, { node: proposed, ownerVersion: owner.versionFingerprint }, 3);
  expect(getOpenLoop(db, "task")?.description).toBe("Workshop Friday.");
  expect(getOpenLoop(db, "task")?.state).toBe("done");
  expect(getKnowledgeNode(db, "task")?.canonicalFields.state).toBe("done");
  expect(getKnowledgeNode(db, "task")?.markdown).toContain("<claim");
  updateOpenLoop(db, "task", { importance: 0.9 }, 4);
  expect(() =>
    saveOwnedKnowledgeNode(
      db,
      { node: { ...proposed, expectedRevision: 2 }, ownerVersion: owner.versionFingerprint },
      4,
    ),
  ).toThrow("Canonical owner changed");
});
it("keeps brief description and body distinct", () => {
  createBrief(
    db,
    {
      id: "brief",
      createdByRun: "run",
      kind: "info",
      title: "Workshop",
      description: "Prepare materials.",
      body: "Workshop Friday.",
      confidence: 0.7,
      urgency: 0.3,
      citations: ["evidence"],
    },
    1,
  );
  const result = convertKnowledgeOwner(db, "brief", "brief", 2);
  const owner = readKnowledgeOwner(db, "brief", "brief");
  saveOwnedKnowledgeNode(
    db,
    {
      node: {
        id: "brief",
        ownerId: "brief",
        kind: "brief",
        title: owner.title,
        markdown: result.node.markdown,
        expectedRevision: 1,
        inputVersions: { "source:evidence": "v1" },
      },
      ownerVersion: owner.versionFingerprint,
    },
    3,
  );
  expect(getBrief(db, "brief")).toMatchObject({
    description: "Prepare materials.",
    body: "Workshop Friday.",
    state: "unread",
  });
});
it("preserves a dismissed snapshot, retains privacy purge, and resumes a snoozed owner when reactivated", () => {
  createBrief(
    db,
    {
      id: "snapshot",
      createdByRun: "run",
      kind: "info",
      title: "Workshop update",
      description: "Workshop Friday.",
      confidence: 0.7,
      urgency: 0.3,
      citations: ["evidence"],
    },
    1,
  );
  convertKnowledgeOwner(db, "brief", "snapshot", 2);
  installKnowledgeOwnerTriggers(db);
  setBriefState(db, "snapshot", "dismissed_snoozed", 3);
  advanceKnowledgeOwnerSync(db, 10, 4);
  const snapshot = getKnowledgeNode(db, "snapshot")!;
  expect(snapshot.metadata.activity).toBe("historical");
  const owner = readKnowledgeOwner(db, "brief", "snapshot");
  expect(() =>
    saveOwnedKnowledgeNode(
      db,
      {
        node: {
          id: owner.id,
          ownerId: owner.id,
          kind: "brief",
          title: owner.title,
          markdown: snapshot.markdown.replace("Friday", "Saturday"),
          expectedRevision: snapshot.revision,
          inputVersions: { "source:evidence": "v1" },
        },
        ownerVersion: owner.versionFingerprint,
      },
      5,
    ),
  ).toThrow("Historical brief snapshots");
  expect(getKnowledgeNode(db, "snapshot")?.markdown).toBe(snapshot.markdown);
  updateBrief(db, "snapshot", { nextShow: null }, 6);
  advanceKnowledgeOwnerSync(db, 10, 7);
  expect(getKnowledgeNode(db, "snapshot")?.metadata.activity).toBe("active");
  setBriefState(db, "snapshot", "dismissed_acknowledged", 8);
  advanceKnowledgeOwnerSync(db, 10, 9);
  purgeKnowledgeBySource(db, "evidence", 10);
  while (advanceKnowledgeCascade(db, 100, 10).pending) {
    /* bounded batches */
  }
  expect(getKnowledgeNode(db, "snapshot")).toBeNull();
  expect(getBrief(db, "snapshot")).toBeNull();
});
it("reconciles canonical state changes, preserves tags, and prevents adapter self-triggering", () => {
  loop();
  convertKnowledgeOwner(db, "loop", "task", 2);
  installKnowledgeOwnerTriggers(db);
  db.prepare("UPDATE open_loops SET state='dismissed' WHERE id='task'").run();
  expect(getKnowledgeNode(db, "task")?.validity).toBe("stale");
  const synced = advanceKnowledgeOwnerSync(db, 10, 3);
  expect(synced.updatedNodeIds).toEqual(["task"]);
  const node = getKnowledgeNode(db, "task")!;
  expect(node.canonicalFields.state).toBe("dismissed");
  expect(node.markdown).toContain('<claim id="legacy"');
  const owner = readKnowledgeOwner(db, "loop", "task");
  saveOwnedKnowledgeNode(
    db,
    {
      node: {
        id: node.id,
        ownerId: node.ownerId,
        kind: node.kind,
        title: node.title,
        markdown: node.markdown,
        expectedRevision: node.revision,
        inputVersions: { "source:evidence": "v1" },
      },
      ownerVersion: owner.versionFingerprint,
    },
    4,
  );
  expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_owner_changes").get()).toEqual({
    count: 0,
  });
});
it("canonical deletion immediately fences knowledge and eventually purges history", () => {
  loop();
  convertKnowledgeOwner(db, "loop", "task", 2);
  installKnowledgeOwnerTriggers(db);
  db.prepare("DELETE FROM open_loops WHERE id='task'").run();
  expect(getKnowledgeNode(db, "task")).toBeNull();
  advanceKnowledgeOwnerSync(db, 10, 3);
  while (advanceKnowledgeCascade(db, 100, 4).pending) {
    /* bounded synchronous fixture drain */
  }
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_revisions WHERE node_id='task'").get(),
  ).toEqual({ count: 0 });
});
it("privacy deletion also removes canonical plaintext that gained support beyond legacy attachments", () => {
  loop();
  convertKnowledgeOwner(db, "loop", "task", 2);
  purgeKnowledgeBySource(db, "evidence", 3);
  expect(getOpenLoop(db, "task")).toBeNull();
  expect(getKnowledgeNode(db, "task")).toBeNull();
});

it.each(["doc_annotation", "person_annotation"] as const)(
  "keeps %s supersession canonical during upgrade and reconciliation",
  (kind) => {
    const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
    const subject = kind === "doc_annotation" ? "doc_id" : "person_id";
    db.prepare(
      `INSERT INTO ${table}(id,${subject},claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      "observation",
      "evidence",
      "schedule",
      "Workshop Friday.",
      "evidence",
      "Workshop Friday.",
      0.7,
      "run",
      1,
    );
    convertKnowledgeOwner(db, kind, "observation", 2);
    installKnowledgeOwnerTriggers(db);
    db.prepare(
      `UPDATE ${table} SET invalidated_at=3,superseded_by='successor' WHERE id='observation'`,
    ).run();
    expect(advanceKnowledgeOwnerSync(db, 10, 4).updatedNodeIds).toEqual(["observation"]);
    expect(getKnowledgeNode(db, "observation")?.canonicalFields).toMatchObject({
      invalidatedAt: 3,
      supersededBy: "successor",
    });
    expect(getKnowledgeNode(db, "observation")?.metadata.activity).toBe("historical");
    const node = getKnowledgeNode(db, "observation")!;
    const owner = readKnowledgeOwner(db, kind, "observation");
    expect(() =>
      saveOwnedKnowledgeNode(
        db,
        {
          node: {
            id: node.id,
            ownerId: node.ownerId,
            kind: node.kind,
            title: node.title,
            markdown: node.markdown,
            expectedRevision: node.revision,
            inputVersions: { "source:evidence": "v1" },
          },
          ownerVersion: owner.versionFingerprint,
        },
        5,
      ),
    ).toThrow("can no longer be revised");
    expect(getKnowledgeNode(db, "observation")?.revision).toBe(node.revision);
  },
);
it.each([false, true])(
  "preserves intentional retirement, then purges its source-derived trace (converted=%s)",
  (converted) => {
    loop();
    if (converted) convertKnowledgeOwner(db, "loop", "task", 2);
    installKnowledgeOwnerTriggers(db);
    deleteOpenLoop(db, "task", { retire: true, now: 3 });
    expect(listRetiredLoops(db)).toHaveLength(1);
    expect(
      db.prepare("SELECT 1 FROM knowledge_node_tombstones WHERE id='task'").get(),
    ).toBeUndefined();
    if (converted) {
      expect(advanceKnowledgeOwnerSync(db, 10, 4).updatedNodeIds).toContain("task");
      expect(getKnowledgeNode(db, "task")?.canonicalFields.state).toBe("retired");
    }
    // Privacy is immediate even before the cascade gets a turn.
    db.prepare("INSERT INTO knowledge_source_revisions VALUES('evidence','',1,5)").run();
    expect(listRetiredLoops(db)).toHaveLength(0);
    purgeKnowledgeBySource(db, "evidence", 6);
    while (advanceKnowledgeCascade(db, 10, 7).pending) {
      /* bounded fixture drain */
    }
    expect(db.prepare("SELECT 1 FROM retired_loops WHERE id='task'").get()).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM knowledge_retired_loop_sources WHERE loop_id='task'").get(),
    ).toBeUndefined();
  },
);
it("yields during attached-brief privacy cleanup instead of deleting arbitrary fanout in one step", () => {
  loop();
  convertKnowledgeOwner(db, "loop", "task", 2);
  for (let i = 0; i < 120; i++)
    createBrief(
      db,
      {
        id: `notice-${i}`,
        createdByRun: "run",
        kind: "info",
        title: "Workshop",
        description: "Prepare materials.",
        confidence: 0.7,
        urgency: 0.3,
        relatedLoopIds: ["task"],
        citations: ["evidence"],
      },
      3,
    );
  installKnowledgeOwnerTriggers(db);
  purgeKnowledgeBySource(db, "evidence", 4);
  const remaining = db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM briefs").get()!
    .count;
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThan(120);
  while (advanceKnowledgeCascade(db, 10, 5).pending) {
    /* bounded fixture drain */
  }
  expect(db.prepare("SELECT COUNT(*) AS count FROM briefs").get()).toEqual({ count: 0 });
});
it.each(["doc_annotation", "person_annotation"])(
  "withdraws %s without privacy-deleting its dependent brief",
  (kind) => {
    const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
    const subject = kind === "doc_annotation" ? "doc_id" : "person_id";
    db.prepare(
      `INSERT INTO ${table}(id,${subject},claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at) VALUES('prior','evidence','schedule','Workshop Friday.','evidence','Workshop Friday.',0.7,'run',1)`,
    ).run();
    convertKnowledgeOwner(db, kind as "doc_annotation" | "person_annotation", "prior", 2);
    createBrief(
      db,
      {
        id: "notice",
        createdByRun: "run",
        kind: "info",
        title: "Workshop",
        description: "Workshop Friday.",
        confidence: 0.7,
        urgency: 0.3,
        citations: ["evidence"],
      },
      2,
    );
    saveKnowledgeNode(
      db,
      {
        id: "notice",
        ownerId: "notice",
        kind: "brief",
        title: "Workshop",
        markdown: '<claim id="date" refs="annotation:prior#claim:legacy">Workshop Friday.</claim>',
        expectedRevision: 0,
        inputVersions: { "annotation:prior#claim:legacy": 1 },
      },
      3,
    );
    installKnowledgeOwnerTriggers(db);
    expect(
      withdrawKnowledgeOwner(db, kind as "doc_annotation" | "person_annotation", "prior", 4),
    ).toBe(true);
    expect(getBrief(db, "notice")).not.toBeNull();
    expect(getKnowledgeNode(db, "notice")?.validity).toBe("stale");
    expect(getKnowledgeNode(db, "prior")?.canonicalFields.withdrawn).toBe(true);
    expect(
      db.prepare("SELECT 1 FROM knowledge_cascade_jobs WHERE kind='purge'").get(),
    ).toBeUndefined();
    purgeKnowledgeBySource(db, "evidence", 5);
    while (advanceKnowledgeCascade(db, 10, 6).pending) {
      /* bounded fixture drain */
    }
    expect(getBrief(db, "notice")).toBeNull();
  },
);
it("rejects canonical owner identity collisions without overwriting another synthesis kind", () => {
  loop();
  saveKnowledgeNode(
    db,
    {
      id: "task",
      kind: "wiki",
      title: "Different context",
      markdown: "",
      expectedRevision: 0,
      inputVersions: {},
    },
    2,
  );
  expect(() => convertKnowledgeOwner(db, "loop", "task", 3)).toThrow("identity collides");
  expect(getKnowledgeNode(db, "task")?.kind).toBe("wiki");
  expect(getOpenLoop(db, "task")?.state).toBe("done");
});

it("synchronizes title-only loops with evidence and later canonical state changes", () => {
  installKnowledgeOwnerTriggers(db);
  createOpenLoop(
    db,
    {
      id: "title-only",
      createdByRun: "run",
      title: "Confirm the workshop count",
      confidence: 0.8,
      importance: 0.5,
      docs: ["evidence"],
    },
    1,
  );
  expect(advanceKnowledgeOwnerSync(db, 10, 2)).toMatchObject({
    pending: false,
    deferred: 0,
    updatedNodeIds: ["title-only"],
  });
  expect(getKnowledgeNode(db, "title-only")).toMatchObject({
    plainText: "Confirm the workshop count",
  });
  expect(getKnowledgeClaims(db, "title-only")[0]?.verification).toBe("unverified");
  expect(getKnowledgeDependencies(db, "title-only")[0]).toMatchObject({
    ref: "source:evidence",
    relation: "context",
  });
  expect(getOpenLoop(db, "title-only")!.description).toBe("");
  db.prepare("UPDATE open_loops SET state='done' WHERE id='title-only'").run();
  expect(advanceKnowledgeOwnerSync(db, 10, 3)).toMatchObject({
    pending: false,
    deferred: 0,
    updatedNodeIds: ["title-only"],
  });
  expect(getKnowledgeNode(db, "title-only")!.canonicalFields.state).toBe("done");
});

it.each(["doc_annotation", "person_annotation"] as const)(
  "preserves %s canonical verification progress for unchanged prose, and resets changed prose",
  (kind) => {
    const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
    const subject = kind === "doc_annotation" ? "doc_id" : "person_id";
    db.prepare(
      `INSERT INTO ${table}(id,${subject},claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at)
      VALUES('observation','evidence','schedule','Workshop Friday.','evidence','Workshop Friday.',0.7,'run',1)`,
    ).run();
    convertKnowledgeOwner(db, kind, "observation", 2);
    const save = (text: string) => {
      const owner = readKnowledgeOwner(db, kind, "observation");
      const node = getKnowledgeNode(db, "observation")!;
      saveOwnedKnowledgeNode(
        db,
        {
          ownerVersion: owner.versionFingerprint,
          node: {
            id: node.id,
            ownerId: node.ownerId,
            kind,
            title: owner.title,
            markdown: `<claim id="legacy" refs="source:evidence">${text}</claim>`,
            expectedRevision: node.revision,
            inputVersions: { "source:evidence": "v1" },
            claims: [{ id: "legacy", relations: { "source:evidence": "context" } }],
          },
        },
        10,
      );
    };
    const verification = () =>
      db
        .prepare(`SELECT verification_state,last_verified_at FROM ${table} WHERE id='observation'`)
        .get();
    save("Workshop Friday.");
    expect(verification()).toEqual({ verification_state: null, last_verified_at: null });
    for (const state of [null, "verified"]) {
      db.prepare(
        `UPDATE ${table} SET verification_state=?,last_verified_at=5 WHERE id='observation'`,
      ).run(state);
      save("Workshop Friday.");
      expect(verification()).toEqual({ verification_state: state, last_verified_at: 5 });
    }
    save("Workshop takes place Friday.");
    expect(verification()).toEqual({ verification_state: "unverified", last_verified_at: null });
  },
);

it.each(["Workshop Friday.", ""])(
  "unchanged loop synthesis preserves decay and canonical activity (description=%s)",
  (description) => {
    createOpenLoop(
      db,
      {
        id: "task",
        createdByRun: "run",
        title: "Prepare workshop",
        description,
        confidence: 0.7,
        importance: 0.5,
        docs: ["evidence"],
      },
      1,
    );
    updateOpenLoop(db, "task", { lastDecayCheck: 2 }, 2);
    const before = getOpenLoop(db, "task");
    const node = convertKnowledgeOwner(db, "loop", "task", 3).node;
    const owner = readKnowledgeOwner(db, "loop", "task");
    saveOwnedKnowledgeNode(
      db,
      {
        node: {
          id: node.id,
          ownerId: node.ownerId,
          kind: node.kind,
          title: node.title,
          markdown: node.markdown,
          expectedRevision: node.revision,
          inputVersions: { "source:evidence": "v1" },
        },
        ownerVersion: owner.versionFingerprint,
      },
      4,
    );
    expect(getOpenLoop(db, "task")).toEqual(before);
    expect(getOpenLoop(db, "task")?.decayCheckCount).toBe(1);
  },
);
