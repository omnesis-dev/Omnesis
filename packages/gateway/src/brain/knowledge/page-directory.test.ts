// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { buildKnowledgeDocumentInput } from "./mirror.js";
import { renderKnowledgePageDirectory } from "./page-directory.js";
import { KNOWLEDGE_PROVIDER_ID } from "./source-meta.js";
import { saveKnowledgeNode } from "./storage.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "page-directory-"));
  db = createDatabase(join(directory, "test.db"));
  document("evidence", "notes", "test", "The observatory opens Saturday.", "evidence");
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function document(
  id: string,
  source: string,
  provider: string,
  text: string,
  externalId: string,
  metadata = {},
) {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?, '2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
  ).run(id, provider, source, externalId, id, text, "v1", JSON.stringify(metadata));
}
function page(
  id: string,
  title: string,
  at: number,
  kind: "wiki" | "root" = "wiki",
  project = true,
) {
  const node = saveKnowledgeNode(
    db,
    {
      id,
      kind,
      title,
      markdown:
        '<claim id="opening" refs="source:evidence">The observatory opens Saturday.</claim>',
      expectedRevision: 0,
      inputVersions: { "source:evidence": "v1" },
    },
    at,
  ).node;
  if (!project) return;
  const projection = buildKnowledgeDocumentInput(node);
  document(
    `projection-${id}`,
    projection.sourceId,
    KNOWLEDGE_PROVIDER_ID,
    projection.content,
    id,
    projection.metadata,
  );
}
const listed = (text: string) =>
  JSON.parse(text.split("\n").at(-1)!) as Array<{ title: string; ref: string }>;

it("lists readable wiki pages newest first, by title and ref", () => {
  page("older", "Observatory visits", 100);
  page("newer", "Telescope   repairs\nplan", 200);
  page("root", "Current context", 300, "root");
  page("unprojected", "Not yet mirrored", 400, "wiki", false);
  const text = renderKnowledgePageDirectory(db);
  expect(text).toContain("## Maintained pages (untrusted reference context)");
  expect(text).toContain("open its page first");
  expect(listed(text)).toEqual([
    { title: "Telescope repairs plan", ref: "wiki:newer" },
    { title: "Observatory visits", ref: "wiki:older" },
  ]);
});

it("leaves out withdrawn and unreadable pages", () => {
  page("kept", "Observatory visits", 100);
  page("withdrawn", "Withdrawn page", 200);
  db.prepare(
    "UPDATE knowledge_nodes SET fields_json=json_set(fields_json,'$.withdrawn',1) WHERE id='withdrawn'",
  ).run();
  page("hidden", "Hidden page", 300);
  db.prepare("UPDATE knowledge_source_revisions SET deleted=1 WHERE document_id='evidence'").run();
  expect(renderKnowledgePageDirectory(db)).toBe("");
});

it("stays within its character budget and says nothing when no page fits", () => {
  for (let i = 0; i < 10; i++) page(`page_${i}`, `Invented subject number ${i}`, 100 + i);
  const full = renderKnowledgePageDirectory(db);
  const budget = full.length - 40;
  const bounded = renderKnowledgePageDirectory(db, budget);
  expect(bounded.length).toBeLessThanOrEqual(budget);
  expect(listed(bounded).length).toBeLessThan(listed(full).length);
  expect(renderKnowledgePageDirectory(db, 50)).toBe("");
});
