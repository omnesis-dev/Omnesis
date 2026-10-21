// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@omnesis/core";
import { resolveBrainSettings } from "../config.js";
import { KnowledgeService, type KnowledgeProposal } from "./service.js";
import { createKnowledgeTables, getKnowledgeNode, saveKnowledgeNode } from "./storage.js";
import { directKnowledgeGate } from "./writer.js";

let db: Database.Database, service: KnowledgeService;
const claim = (id: string, text: string) =>
  `<claim id="${id}" refs="source:manual">${text}</claim>`;
const first = claim("labels", "Blue labels identify the first cabinet.");
const second = claim("tools", "Tools belong in the second cabinet.");
const input = (extra: Partial<KnowledgeProposal> = {}): KnowledgeProposal => ({
  id: "reference",
  kind: "wiki",
  title: "Workshop storage reference",
  markdown: first + second,
  expectedRevision: 0,
  inputVersions: { "source:manual": "v1" },
  ...extra,
});
beforeEach(async () => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
  db.prepare("INSERT INTO documents VALUES('manual',?,'v1')").run(
    "Blue labels identify the first cabinet. Tools belong in the second cabinet.",
  );
  createKnowledgeTables(db);
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    clock: () => 1,
    getSettings: () => resolveBrainSettings(),
    log: createLogger("claim-preservation-test"),
  });
  await service.save(input());
});
afterEach(() => db.close());

it.each(["", '<claim id="review" refs="">Existing context remains current.</claim>', first])(
  "refuses undeclared full or partial replacement without mutation: %s",
  async (markdown) => {
    const before = getKnowledgeNode(db, "reference");
    await expect(service.save(input({ expectedRevision: 1, markdown }))).rejects.toMatchObject({
      code: "claim_invalid",
    });
    expect(getKnowledgeNode(db, "reference")).toEqual(before);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM knowledge_revisions WHERE node_id='reference'").get(),
    ).toEqual({ n: 1 });
  },
);
it("allows a narrow deliberate removal and records its reason in the revision audit", async () => {
  const saved = await service.save(
    input({
      expectedRevision: 1,
      markdown: first,
      claimRemovals: [
        { id: "tools", reason: "Retired section now maintained in the equipment reference." },
      ],
    }),
  );
  expect(saved.node.markdown).toBe(first);
  const row = db
    .prepare<
      [],
      { diff_json: string }
    >("SELECT diff_json FROM knowledge_revisions WHERE node_id='reference' AND revision=2")
    .get()!;
  expect(JSON.parse(row.diff_json).claimRemovals).toEqual([
    { id: "tools", reason: "Retired section now maintained in the equipment reference." },
  ]);
});
it.each(
  [
    [{ id: "unknown", reason: "No longer needed." }],
    [{ id: "labels", reason: "Still retained." }],
    [{ id: "tools", reason: "" }],
    [{ id: "tools", reason: "   " }],
    [{ id: "tools", reason: "x".repeat(1001) }],
    [
      { id: "tools", reason: "Retired." },
      { id: "tools", reason: "Retired twice." },
    ],
  ].map((claimRemovals) => ({ claimRemovals })),
)("rejects invalid removal intent $claimRemovals", async ({ claimRemovals }) => {
  await expect(
    service.save(input({ expectedRevision: 1, markdown: first, claimRemovals })),
  ).rejects.toMatchObject({ code: "claim_invalid" });
});
it("rejects removal intents on newly created pages and forbids an explicitly emptied wiki", async () => {
  await expect(
    service.save(
      input({ id: "new", claimRemovals: [{ id: "tools", reason: "Not a prior claim." }] }),
    ),
  ).rejects.toMatchObject({ code: "claim_invalid" });
  await expect(
    service.save(
      input({
        expectedRevision: 1,
        markdown: "",
        claimRemovals: [
          { id: "labels", reason: "Retired." },
          { id: "tools", reason: "Retired." },
        ],
      }),
    ),
  ).rejects.toMatchObject({ code: "claim_invalid" });
});
it("permits explicit root compaction while preserving the remaining context", async () => {
  await service.save(input({ id: "root", kind: "root" }));
  const saved = await service.save(
    input({
      id: "root",
      kind: "root",
      expectedRevision: 1,
      markdown: first,
      claimRemovals: [
        {
          id: "tools",
          reason: "Detail stays on its dedicated reference page; compact root navigation.",
        },
      ],
    }),
  );
  expect(saved.node.markdown).toBe(first);
});
it("enforces the guard independently inside the writer and leaves internal conversion writes available", () => {
  expect(() =>
    saveKnowledgeNode(
      db,
      { ...input({ expectedRevision: 1, markdown: first }), enforceClaimPreservation: true },
      2,
    ),
  ).toThrow(/omits existing claims/);
  expect(getKnowledgeNode(db, "reference")!.revision).toBe(1);
  expect(
    saveKnowledgeNode(db, input({ expectedRevision: 1, markdown: first }), 2).node.revision,
  ).toBe(2);
});
it("rechecks full replacement intent after asynchronous verification", async () => {
  const proposed = input({ expectedRevision: 1 });
  service.deps.getEntailmentVerifier = async () => ({
    verify: async () => {
      proposed.markdown = first;
      return { label: "entailment", probability: 1 };
    },
    dispose() {},
  });
  await expect(service.save(proposed)).rejects.toThrow(/omits existing claims/);
  expect(getKnowledgeNode(db, "reference")!.markdown).toBe(first + second);
});

it.each(["missing", "erasing", "tombstoned"])(
  "uses the same unavailable boundary for %s update targets",
  async (mode) => {
    if (mode === "missing") db.prepare("DELETE FROM knowledge_nodes WHERE id='reference'").run();
    else if (mode === "erasing")
      db.prepare(
        "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','node','reference','deleted',1)",
      ).run();
    else
      db.prepare(
        "INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('reference',1)",
      ).run();
    const proposed = input({ expectedRevision: 1, markdown: first });
    await expect(service.save(proposed)).rejects.toMatchObject({
      code: "reference_invalid",
      message: "Synthesis page is unavailable",
    });
    expect(() => saveKnowledgeNode(db, { ...proposed, enforceClaimPreservation: true }, 2)).toThrow(
      "Synthesis page is unavailable",
    );
  },
);
it("returns revision conflict before exposing current omitted claim IDs", async () => {
  await expect(
    service.save(input({ expectedRevision: 99, markdown: first })),
  ).rejects.toMatchObject({
    code: "revision_conflict",
    message: "Node revision changed; fetch the current page before revising it",
  });
});
it("rechecks privacy inside the writer after asynchronous verification", async () => {
  let checks = 0;
  service.deps.getEntailmentVerifier = async () => ({
    verify: async () => {
      if (++checks === 2)
        db.prepare(
          "INSERT OR REPLACE INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('manual','v1',1,1)",
        ).run();
      return { label: "entailment", probability: 1 };
    },
    dispose() {},
  });
  await expect(service.save(input({ expectedRevision: 1 }))).rejects.toMatchObject({
    code: "reference_invalid",
  });
  expect(db.prepare("SELECT revision FROM knowledge_nodes WHERE id='reference'").get()).toEqual({
    revision: 1,
  });
});

describe("a single save cannot gut a page", () => {
  const shelves = ["one", "two", "three", "four", "five", "six"].map((name) =>
    claim(name, `Shelf ${name} holds one kind of tool.`),
  );
  const large = (extra: Partial<KnowledgeProposal> = {}) =>
    input({ id: "large", title: "Workshop shelves", markdown: shelves.join(""), ...extra });
  const keep = (...kept: number[]) => kept.map((index) => shelves[index]!).join("");
  const removing = (ids: string[], reason?: (id: string) => string) =>
    ids.map((id) => ({ id, reason: reason?.(id) ?? `Shelf ${id} was emptied and relabelled.` }));
  const paint = claim("paint", "Paint stays sealed.");
  beforeEach(async () => {
    await service.save(large());
  });

  it("refuses removing more than half of the claims once three or more go, saving nothing", async () => {
    const before = getKnowledgeNode(db, "large");
    const gutted = large({
      expectedRevision: 1,
      markdown: keep(0, 1),
      claimRemovals: removing(["three", "four", "five", "six"]),
    });
    await expect(service.save(gutted)).rejects.toMatchObject({
      code: "claim_invalid",
      message: expect.stringMatching(/removes 4 of the page's 6 claims.*knowledge_retire/),
    });
    expect(getKnowledgeNode(db, "large")).toEqual(before);
    // The writer rechecks it on its own.
    expect(() => saveKnowledgeNode(db, { ...gutted, enforceClaimPreservation: true }, 2)).toThrow(
      /removes 4 of the page's 6 claims/,
    );
  });

  it("allows removing half of the claims, each for its own reason", async () => {
    const saved = await service.save(
      large({
        expectedRevision: 1,
        markdown: keep(0, 1, 2),
        claimRemovals: removing(["four", "five", "six"]),
      }),
    );
    expect(saved.node.markdown).toBe(keep(0, 1, 2));
  });

  it("refuses one removal reason shared by more than two claims", async () => {
    await expect(
      service.save(
        large({
          expectedRevision: 1,
          markdown: keep(0, 1, 2),
          claimRemovals: removing(["four", "five", "six"], (id) =>
            id === "six"
              ? "cannot be re-checked  in this run."
              : "Cannot be re-checked in this run.",
          ),
        }),
      ),
    ).rejects.toMatchObject({
      code: "claim_invalid",
      message: expect.stringContaining("same removal reason for 3 claims"),
    });
    // Two claims may share one reason.
    const saved = await service.save(
      large({
        expectedRevision: 1,
        markdown: keep(0, 1, 2, 3),
        claimRemovals: removing(["five", "six"], () => "Duplicates shelf one."),
      }),
    );
    expect(saved.node.revision).toBe(2);
  });

  it("refuses retitling a page while removing most of it, not the same small removal", async () => {
    await service.save(input({ id: "small", markdown: first + second + paint }));
    const removals = [
      { id: "labels", reason: "Labels are covered by the signage page." },
      { id: "tools", reason: "Tools moved to the equipment reference." },
    ];
    await expect(
      service.save(
        input({
          id: "small",
          title: "Paint storage",
          expectedRevision: 1,
          markdown: paint,
          claimRemovals: removals,
        }),
      ),
    ).rejects.toMatchObject({
      code: "claim_invalid",
      message: expect.stringContaining("retitles the page while removing 2 of its 3 claims"),
    });
    // Removing two of three claims under the same title is a reasonable small edit.
    const saved = await service.save(
      input({ id: "small", expectedRevision: 1, markdown: paint, claimRemovals: removals }),
    );
    expect(saved.node.markdown).toBe(paint);
  });
});
