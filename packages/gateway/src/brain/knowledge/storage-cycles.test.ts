// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { parseClaimMarkup } from "./claims.js";
import { assertAcyclicKnowledgeClaims } from "./storage-cycles.js";

it("refuses an oversized dependency walk instead of monopolizing the writer or assuming no cycle", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE knowledge_dependencies(node_id TEXT,claim_id TEXT,target_id TEXT,ref TEXT,target_kind TEXT,relation TEXT); CREATE INDEX edge_node ON knowledge_dependencies(node_id)",
    );
    const insert = db.prepare(
      "INSERT INTO knowledge_dependencies VALUES(?,'fact',?,?,'node','supports')",
    );
    db.transaction(() => {
      for (let i = 0; i < 3000; i++)
        insert.run(`page${i}`, `page${i + 1}`, `wiki:page${i + 1}#claim:fact`);
    })();
    // All references select exact claim IDs; no page-wide claim enumeration is needed.
    db.exec("CREATE TABLE knowledge_claims(node_id TEXT,id TEXT)");
    const claims = parseClaimMarkup(
      '<claim id="fact" refs="wiki:page0#claim:fact">A fact.</claim>',
    ).claims;
    expect(() =>
      assertAcyclicKnowledgeClaims(db, "new", claims, [
        {
          nodeId: "new",
          claimId: "fact",
          ref: "wiki:page0#claim:fact",
          targetId: "page0",
          targetKind: "node",
          relation: "supports",
          inputVersion: 1,
        },
      ]),
    ).toThrow("bounded write budget");
  } finally {
    db.close();
  }
});
