// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createKnowledgeTables, saveKnowledgeNode } from "./storage.js";
import {
  assertNoOverlappingScope,
  assertWikiPublicationReceipt,
  assertWikiSourceDiversity,
  WikiPublicationReads,
} from "./wiki-publication.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,content TEXT,content_hash TEXT)",
  );
  createKnowledgeTables(db);
  db.exec(
    "INSERT INTO documents VALUES('spec','fictional','Observatory design','The observatory uses a reflector.','design-v1'),('permit','fictional','Observatory permit','The permit was approved.','permit-v1'),('copy','fictional','Design copy','The observatory uses a reflector.','design-v1')",
  );
});
afterEach(() => db.close());
function page(id: string, second: string, context = false) {
  return saveKnowledgeNode(
    db,
    {
      id,
      kind: "wiki",
      title: "Observatory reference",
      expectedRevision: 0,
      markdown: `<claim id="design" refs="source:spec">The observatory uses a reflector.</claim><claim id="permit" refs="source:${second}">The permit was approved.</claim>`,
      inputVersions: {
        "source:spec": "design-v1",
        [`source:${second}`]: second === "copy" ? "design-v1" : "permit-v1",
      },
      claims: context
        ? [{ id: "permit", relations: { [`source:${second}`]: "context" } }]
        : undefined,
    },
    1,
  ).node;
}
it("counts distinct supporting documents, excluding context and identical copies", () => {
  page("complete", "permit");
  expect(() => assertWikiSourceDiversity(db, "complete")).not.toThrow();
  page("context", "permit", true);
  expect(() => assertWikiSourceDiversity(db, "context")).toThrow("at least two");
  page("copied", "copy");
  expect(() => assertWikiSourceDiversity(db, "copied")).toThrow("at least two");
});
it("follows exact claim supports without broadening to neighboring claims", () => {
  page("details", "permit");
  saveKnowledgeNode(
    db,
    {
      id: "rollup",
      kind: "wiki",
      title: "Observatory",
      expectedRevision: 0,
      markdown:
        '<claim id="overview" refs="wiki:details#claim:design">The observatory uses a reflector.</claim>',
      inputVersions: { "wiki:details#claim:design": 1 },
    },
    2,
  );
  expect(() => assertWikiSourceDiversity(db, "rollup")).toThrow("at least two");
  saveKnowledgeNode(
    db,
    {
      id: "combined",
      kind: "wiki",
      title: "Observatory",
      expectedRevision: 0,
      markdown:
        '<claim id="overview" refs="wiki:details#claim:design wiki:details#claim:permit">The approved observatory uses a reflector.</claim>',
      inputVersions: { "wiki:details#claim:design": 1, "wiki:details#claim:permit": 1 },
    },
    2,
  );
  expect(() => assertWikiSourceDiversity(db, "combined")).not.toThrow();
  db.prepare("UPDATE documents SET content_hash='permit-v2' WHERE id='permit'").run();
  expect(() => assertWikiSourceDiversity(db, "combined")).toThrow("at least two");
});
it("refuses a removed second source before a cascade can run", () => {
  page("complete", "permit");
  db.exec(
    "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','source','permit','permit-v1',2)",
  );
  expect(() => assertWikiSourceDiversity(db, "complete")).toThrow("at least two");
});
it("requires actual library, candidate and selected counterpart reads, without invalidating unrelated edits", () => {
  const reads = new WikiPublicationReads(db);
  const assessment = {
    reason: "The observing design scope is distinct from existing instrument maintenance.",
    relatedPageIds: ["instruments"],
  };
  expect(() => reads.receipt("candidate", assessment)).toThrow("wiki_scope");
  const related = page("instruments", "permit");
  reads.library();
  reads.candidatesRead(["candidate"], true);
  expect(() => reads.receipt("candidate", assessment)).toThrow("Read every");
  reads.nodeRead(related);
  const receipt = reads.receipt("candidate", assessment);
  db.prepare("UPDATE knowledge_nodes SET updated_at=updated_at+1 WHERE id='instruments'").run();
  expect(() => assertWikiPublicationReceipt(db, "candidate", receipt)).not.toThrow();
  db.prepare("UPDATE knowledge_nodes SET revision=revision+1 WHERE id='instruments'").run();
  expect(() => assertWikiPublicationReceipt(db, "candidate", receipt)).toThrow(
    "changed or became unavailable",
  );
});

it("fences newly published scopes while ordinary prose edits do not invalidate the inventory", () => {
  page("selected", "permit");
  const reads = new WikiPublicationReads(db);
  reads.library();
  reads.candidatesRead(["candidate"], true);
  const assessment = { reason: "A distinct observing reference.", relatedPageIds: [] };
  const receipt = reads.receipt("candidate", assessment);
  db.prepare(
    "UPDATE knowledge_nodes SET markdown='Reorganized prose',revision=revision+1 WHERE id='selected'",
  ).run();
  expect(() => assertWikiPublicationReceipt(db, "candidate", receipt)).not.toThrow();
  page("concurrent", "permit");
  expect(() => assertWikiPublicationReceipt(db, "candidate", receipt)).toThrow("wiki_scope");
  reads.library();
  expect(() => reads.receipt("candidate", assessment)).toThrow("wiki_scope");
  reads.candidatesRead(["candidate"], true);
  expect(() => reads.receipt("candidate", assessment)).not.toThrow();
});

it("does not certify inventory when its read crosses a scope mutation", () => {
  const reads = new WikiPublicationReads(db);
  expect(() =>
    reads.snapshot(
      () => {
        page("during-read", "permit");
        return [];
      },
      () => reads.library(),
    ),
  ).toThrow("wiki_scope");
  reads.candidatesRead(["candidate"], true);
  expect(() =>
    reads.receipt("candidate", { reason: "Distinct topic.", relatedPageIds: [] }),
  ).toThrow("wiki_scope");
});

describe("overlapping scope", () => {
  const draft = {
    id: "telescope",
    title: "Observatory telescope",
    scope: "The reflector the observatory uses and its approved permit",
    markdown:
      '<claim id="design" refs="source:spec">The observatory uses a reflector telescope.</claim><claim id="permit" refs="source:permit">The observatory permit was approved.</claim>',
  };
  const log = createLogger("wiki-publication-test");
  function garden() {
    saveKnowledgeNode(
      db,
      {
        id: "garden",
        kind: "wiki",
        title: "Garden",
        expectedRevision: 0,
        markdown: '<claim id="bulbs" refs="source:spec">Tulip bulbs go in before frost.</claim>',
        inputVersions: { "source:spec": "design-v1" },
      },
      1,
    );
  }
  const check = (
    search: Parameters<typeof assertNoOverlappingScope>[1],
    relatedPageIds: string[] = [],
  ) =>
    assertNoOverlappingScope(
      db,
      search,
      draft,
      { reason: "A distinct telescope reference.", relatedPageIds },
      { candidateId: "candidate", log, discoveryTargets: false },
    );

  it("refuses a new page while a close current page is not named in its assessment", async () => {
    page("instruments", "permit");
    garden();
    const search = vi.fn(async (_query: string) => ["garden", "instruments"]);
    const refusal = check(search);
    await expect(refusal).rejects.toMatchObject({ code: "claim_invalid" });
    const message = await refusal.catch((error: Error) => error.message);
    expect(message).toContain('"id":"instruments"');
    expect(message).toContain('"title":"Observatory reference"');
    expect(message).toContain('knowledge_candidate_decide({status:"merged",nodeId})');
    expect(message).not.toContain("garden");
    expect(message).not.toContain("knowledge_discovery_complete");
    // The title, scope and leading claims are the queries.
    expect(search.mock.calls.map(([query]) => query)).toEqual([
      `${draft.title}. ${draft.scope}`,
      `${draft.title}. The observatory uses a reflector telescope.`,
      `${draft.title}. The observatory permit was approved.`,
    ]);
  });

  it("publishes once the close page is named, and when no current page is close", async () => {
    page("instruments", "permit");
    garden();
    await expect(check(async () => ["instruments"], ["instruments"])).resolves.toBeUndefined();
    await expect(check(async () => ["garden"])).resolves.toBeUndefined();
    await expect(check(async () => [])).resolves.toBeUndefined();
    // The page being published is never its own overlap.
    page("telescope", "permit");
    await expect(check(async () => ["telescope"])).resolves.toBeUndefined();
  });

  it("checks only the closest pages, so naming them is enough", async () => {
    for (const id of ["first", "second", "third", "fourth"]) page(id, "permit");
    const search = async () => ["first", "second", "third", "fourth"];
    await expect(check(search, ["first", "second", "third"])).resolves.toBeUndefined();
  });

  it("publishes without the check when search is unavailable", async () => {
    page("instruments", "permit");
    const warn = vi.spyOn(log, "warn");
    await expect(
      check(async () => {
        throw new Error("index offline");
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Overlapping wiki scopes for telescope not checked: index offline",
    );
    await expect(check(undefined)).resolves.toBeUndefined();
  });
});
