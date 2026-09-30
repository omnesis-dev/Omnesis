// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { createDatabase } from "../db.js";
import { hiddenSourceIdsToExclude } from "./hidden-sources.js";
import { enrichAgentSearch, type AgentSearchProvenanceOptions } from "./agent-provenance.js";
import type { SearchResultItem } from "./types.js";
import type Database from "better-sqlite3";

const NOW = "2026-01-01T10:00:00.000Z";
const BODY =
  "A fictional document describes the specifications for an invented garden shelter, its materials and delivery schedule.";
const DEFAULTS: AgentSearchProvenanceOptions = {
  limit: 10,
  topN: 3,
  maxDepth: 4,
  fanout: 6,
  maxNodes: 24,
  maxCopies: 8,
  maxSummaryChars: 700,
};
let db: Database.Database;
let dbPath: string;

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
});

function doc(
  id: string,
  options: {
    type?: string;
    source?: string;
    body?: string;
    hash?: string;
    lowSignal?: boolean;
    stream?: string;
    extra?: Record<string, unknown>;
  } = {},
): SearchResultItem {
  const source = options.source ?? "archive:fictional";
  const body = options.body ?? BODY;
  const type = options.type ?? "file";
  const metadata = {
    documentType: type,
    sourceUrl: `https://example.org/${id}`,
    lowSignal: options.lowSignal,
    extra: options.extra,
  };
  db.prepare(
    `INSERT INTO documents
    (id,provider_id,source_id,external_id,stream_id,title,content,content_hash,extracted_content_hash,
     metadata,source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES (?,'fictional',?,?,?, ?,?,?,?, ?,?,?,?,?)`,
  ).run(
    id,
    source,
    id,
    options.stream ?? "",
    `Title ${id}`,
    body,
    computeContentHash(body),
    options.hash ?? computeContentHash(body),
    JSON.stringify(metadata),
    NOW,
    NOW,
    NOW,
    NOW,
  );
  return {
    documentId: id,
    sourceId: source,
    title: `Title ${id}`,
    documentType: type,
    sourceCreatedAt: NOW,
    chunkText: body,
    score: 1,
    sourceUrl: `https://example.org/${id}`,
  };
}
function edge(from: string, to: string, type = "url"): void {
  db.prepare(
    `INSERT INTO document_links
    (source_doc_id,link_type,raw_target,normalized_target,target_doc_id,created_at)
    VALUES (?,?,?,?,?,?)`,
  ).run(from, type, to, to, to, NOW);
}
function role(id: string, documentId: string, name: string, personRole = "participant"): void {
  db.prepare(
    `INSERT OR IGNORE INTO people
    (id,canonical_name,source,first_seen,last_seen,created_at,updated_at)
    VALUES (?,?,'fictional',?,?,?,?)`,
  ).run(id, name, NOW, NOW, NOW, NOW);
  db.prepare("INSERT INTO document_people (document_id,person_id,role) VALUES (?,?,?)").run(
    documentId,
    id,
    personRole,
  );
}
function search(hits: SearchResultItem[], overrides: Partial<AgentSearchProvenanceOptions> = {}) {
  return enrichAgentSearch(db, hits, { ...DEFAULTS, ...overrides });
}

describe("agent graph search evidence", () => {
  test("groups the ranked pool before limiting and discovers copies outside it", () => {
    const best = doc("best");
    const duplicate = doc("duplicate", { source: "files:fictional", type: "attachment" });
    doc("off-pool", { source: "archive:other" });
    const unrelated = doc("unrelated", { body: BODY + " A different revision." });
    const hits = search([best, duplicate, unrelated], { limit: 2 });
    expect(hits.map((h) => h.documentId)).toEqual(["best", "unrelated"]);
    expect(hits[0].provenance?.copies.map((c) => c.documentId).sort()).toEqual([
      "best",
      "duplicate",
      "off-pool",
    ]);
    expect(hits[0].provenance?.copies[1].url).toMatch(/^https:\/\/example\.org\//);
    expect(hits[0].provenance?.summary).toContain("Matching extracted text");
    expect(best).not.toHaveProperty("provenance");
  });

  test("invalid off-pool rows cannot hide IDs of already grouped ranked copies", () => {
    const hash = computeContentHash(BODY);
    const best = doc("best");
    for (let n = 0; n < 10; n++) {
      doc(`invalid-low-${n}`, { hash, lowSignal: true });
      doc(`invalid-short-${n}`, { hash, body: "short" });
    }
    const ranked = doc("ranked-copy");
    const provenance = search([best, ranked], { maxCopies: 3 })[0].provenance!;
    expect(provenance.copies.map((copy) => copy.documentId)).toEqual(["best", "ranked-copy"]);
    expect(provenance.copies.every((copy) => !copy.documentId.startsWith("invalid"))).toBe(true);
    expect(provenance.truncated).toBe(true);
  });

  test("ranked family overflow reports copy-budget truncation", () => {
    const ranked = Array.from({ length: 6 }, (_, n) => doc(`ranked-${n}`));
    const hits = search(ranked, { maxCopies: 3 });
    expect(hits).toHaveLength(1);
    expect(hits[0].provenance?.copies.map((copy) => copy.documentId)).toEqual([
      "ranked-0",
      "ranked-1",
      "ranked-2",
    ]);
    expect(hits[0].provenance?.stopReasons).toContain("copies");
  });

  test("preserves authored messages, empty extraction, short text and low signal files", () => {
    const messageA = doc("mail-a", { type: "email" });
    const messageB = doc("mail-b", { type: "email" });
    const emptyA = doc("empty-a", {
      body: "# Descriptive file wrapper\n---\n",
      hash: computeContentHash(""),
    });
    const emptyB = doc("empty-b", {
      body: "# A different wrapper\n---\n",
      hash: computeContentHash(""),
    });
    const shortA = doc("short-a", { body: "short" });
    const shortB = doc("short-b", { body: "short" });
    const lowA = doc("low-a", { lowSignal: true });
    const lowB = doc("low-b", { lowSignal: true });
    expect(search([messageA, messageB, emptyA, emptyB, shortA, shortB, lowA, lowB])).toHaveLength(
      8,
    );
  });

  test("stale indexed chunks cannot group or acquire current graph claims", () => {
    const a = doc("a");
    const b = doc("b");
    const hashes = {
      a: computeContentHash("Earlier unrelated indexed revision."),
      b: computeContentHash("Another earlier indexed revision."),
    };
    const hits = search([a, b], { indexedContentHashes: hashes });
    expect(hits.map((h) => h.documentId)).toEqual(["a", "b"]);
    expect(hits.every((h) => h.provenance === undefined)).toBe(true);
  });

  test("does not collapse near duplicates or canonical resource representations", () => {
    const a = doc("a");
    const b = doc("b", { body: BODY + " Additional requirement." });
    edge("a", "b", "same-resource");
    db.prepare(
      `INSERT INTO near_dup_edges
      (doc_a,doc_b,jaccard,algo_version,pair_unique_df2,pair_unique_df5,containment_min,gate_family,computed_at)
      VALUES ('a','b',0.98,'fictional',2,2,0.98,'file',1)`,
    ).run();
    const hits = search([a, b]);
    expect(hits).toHaveLength(2);
    expect(hits[0].provenance?.paths).toEqual([]);
  });

  test("follows sparse multihop file-sharing evidence but never hops through people", () => {
    const file = doc("file");
    doc("attachment", { type: "attachment" });
    doc("forward", { type: "email", body: "Fictional forwarding message." });
    doc("chat", { type: "message", body: "Fictional reference to the archive file." });
    doc("unrelated-chat", { type: "message", body: "A completely unrelated conversation." });
    edge("attachment", "forward", "contains");
    edge("chat", "file");
    role("person", "chat", "Jamie Lopez");
    role("person", "unrelated-chat", "Jamie Lopez");
    role("sender", "forward", "Maya Reeves", "sender");
    const provenance = search([file])[0].provenance!;
    expect(provenance.summary).toContain("participant: Jamie Lopez");
    expect(provenance.summary).toContain("sender: Maya Reeves");
    expect(provenance.summary).not.toContain("sender: Jamie Lopez");
    expect(provenance.paths.flatMap((p) => p.documentIds)).not.toContain("unrelated-chat");
    expect(provenance.paths.some((p) => p.edges.includes("outbound:contains"))).toBe(true);
  });

  test("reaches a document hub but stops before its unrelated references", () => {
    const seed = doc("seed", { body: BODY });
    doc("hub", { type: "note", body: "An index of unrelated references." });
    edge("seed", "hub", "references");
    for (let n = 0; n < 20; n++) {
      doc(`leaf-${n}`, { type: "note", body: `Unrelated reference ${n}.` });
      edge("hub", `leaf-${n}`, "references");
    }
    const provenance = search([seed])[0].provenance!;
    expect(provenance.paths).toEqual([
      { documentIds: ["seed", "hub"], edges: ["outbound:references"] },
    ]);
    expect(provenance.stopReasons).toContain("hub");
    expect(provenance.truncated).toBe(true);
  });

  test("parallel sparse relationships preserve structural priority without becoming a hub", () => {
    const seed = doc("seed");
    doc("target", { type: "note", body: "A fictional related note." });
    for (const type of ["url", "references", "part-of-thread", "contains"])
      edge("seed", "target", type);
    const provenance = search([seed], { fanout: 1 })[0].provenance!;
    expect(provenance.paths).toEqual([
      { documentIds: ["seed", "target"], edges: ["outbound:contains"] },
    ]);
    expect(provenance.stopReasons).not.toContain("hub");
    expect(search([seed], { fanout: 1 })[0].provenance).toEqual(provenance);
  });

  test("keeps copy IDs below the graph enrichment rank budget", () => {
    const first = doc("first", { body: BODY + " First distinct document." });
    const second = doc("second");
    const third = doc("third");
    const hits = search([first, second, third], { topN: 1 });
    expect(hits).toHaveLength(2);
    expect(hits[1].provenance?.copies.map((c) => c.documentId).sort()).toEqual(["second", "third"]);
    expect(hits[1].provenance?.paths).toEqual([]);
  });

  test("below-topN one-copy inventories preserve family overflow warnings", () => {
    const first = doc("first", { body: BODY + " A distinct leading hit." });
    const second = doc("second");
    const third = doc("third");
    const hits = search([first, second, third], { topN: 1, maxCopies: 1 });
    expect(hits).toHaveLength(2);
    expect(hits[1].provenance?.copies.map((copy) => copy.documentId)).toEqual(["second"]);
    expect(hits[1].provenance?.paths).toEqual([]);
    expect(hits[1].provenance?.truncated).toBe(true);
    expect(hits[1].provenance?.stopReasons).toContain("copies");
  });

  test("containment prose preserves evidence without assuming a uniform stored direction", () => {
    const parent = doc("parent", { type: "email", body: "A fictional container document." });
    const child = doc("child", { type: "attachment" });
    edge("child", "parent", "contains");
    expect(search([child])[0].provenance?.summary).toContain(
      "has a containment connection to Title parent",
    );
    expect(search([parent])[0].provenance?.summary).toContain(
      "has a containment connection to Title child",
    );
    expect(search([parent])[0].provenance?.paths[0].edges).toEqual(["inbound:contains"]);
    expect(search([child])[0].provenance?.paths[0].edges).toEqual(["outbound:contains"]);
  });

  test("prefers authoritative URLs, omits oversized links and bounds metadata", () => {
    const seed = doc("seed", { extra: { path: "x".repeat(400) } });
    db.prepare("UPDATE documents SET source_url = ?, title = ? WHERE id = 'seed'").run(
      "https://example.org/authoritative",
      "y".repeat(400),
    );
    let hit = search([seed])[0];
    expect(hit.provenance?.copies[0].url).toBe("https://example.org/authoritative");
    expect(hit.provenance?.copies[0].title).toHaveLength(240);
    expect(hit.provenance?.copies[0].path).toHaveLength(240);
    db.prepare("UPDATE documents SET source_url = ? WHERE id = 'seed'").run(
      "https://example.org/" + "a".repeat(3000),
    );
    hit = search([seed])[0];
    expect(hit.provenance?.copies[0].url).toBeUndefined();
  });

  test("never exposes hidden or excluded copies, endpoints or own conversation", () => {
    const seed = doc("seed");
    const hiddenSource = hiddenSourceIdsToExclude()[0];
    expect(hiddenSource).toBeDefined();
    doc("hidden-copy", { source: hiddenSource });
    doc("hidden-node", { source: hiddenSource, type: "note", body: "Hidden annotation." });
    doc("own-chat", { type: "message", body: "Current agent conversation." });
    doc("excluded-copy");
    edge("own-chat", "seed");
    edge("seed", "hidden-node", "references");
    const hit = search([seed], { excludeDocumentIds: ["own-chat", "excluded-copy"] })[0];
    expect(hit.provenance?.copies.map((c) => c.documentId)).toEqual(["seed"]);
    expect(hit.provenance?.paths).toEqual([]);
    expect(JSON.stringify(hit.provenance)).not.toMatch(
      /hidden-copy|hidden-node|own-chat|excluded-copy/,
    );
    expect(search([doc("excluded-hit")], { excludeDocumentIds: ["excluded-hit"] })).toEqual([]);
  });

  test("resolves lazy exclusions against the same snapshot as copies and graph paths", () => {
    const seed = doc("seed");
    const excludedIds: string[] = [];
    const excludeDocumentIds = (): readonly string[] => {
      expect(db.inTransaction).toBe(true);
      return excludedIds;
    };
    const chat = doc("late-chat", {
      type: "message",
      body: "A transcript indexed while the query was waiting.",
    });
    doc("late-copy");
    edge(chat.documentId, seed.documentId);
    excludedIds.push("late-chat", "late-copy");
    const hits = search([seed, chat], { excludeDocumentIds });
    expect(hits.map((hit) => hit.documentId)).toEqual(["seed"]);
    expect(hits[0].provenance?.copies.map((copy) => copy.documentId)).toEqual(["seed"]);
    expect(hits[0].provenance?.paths).toEqual([]);
    expect(JSON.stringify(hits[0].provenance)).not.toMatch(/late-chat|late-copy/);
  });

  test("current source visibility overrides stale index source metadata without a hash change", () => {
    const seed = doc("moved-hidden");
    const hiddenSource = hiddenSourceIdsToExclude()[0];
    expect(hiddenSource).toBeDefined();
    db.prepare("UPDATE documents SET source_id = ? WHERE id = ?").run(
      hiddenSource,
      seed.documentId,
    );
    expect(
      search([seed], { indexedContentHashes: { [seed.documentId]: computeContentHash(BODY) } }),
    ).toEqual([]);
  });

  test("uses partition device stream instead of source primary and preserves bounded path", () => {
    for (const [id, name] of [
      ["primary", "Fictional desktop"],
      ["contributor", "Fictional laptop"],
    ]) {
      db.prepare("INSERT INTO devices (id,name,kind,paired_at) VALUES (?,?,'collector',1)").run(
        id,
        name,
      );
    }
    db.prepare(
      `INSERT INTO sources (id,type,account_id,device_id,multi_device_mode,created_at,updated_at)
      VALUES ('files:fictional','files','fictional','primary','partitioned',1,1)`,
    ).run();
    const file = doc("partitioned", {
      source: "files:fictional",
      stream: "contributor",
      extra: { path: "~/Documents/fictional-plan.pdf" },
    });
    const copy = search([file])[0].provenance?.copies[0];
    expect(copy?.deviceName).toBe("Fictional laptop");
    expect(copy?.path).toBe("~/Documents/fictional-plan.pdf");
  });

  test("cloud collector ownership does not claim a storage device", () => {
    db.prepare(
      "INSERT INTO devices (id,name,kind,paired_at) VALUES ('collector','Fictional desktop','collector',1)",
    ).run();
    db.prepare(
      `INSERT INTO sources (id,type,account_id,device_id,multi_device_mode,created_at,updated_at)
      VALUES ('archive:fictional','archive','fictional','collector','exclusive',1,1)`,
    ).run();
    const seed = doc("cloud");
    expect(search([seed])[0].provenance?.copies[0].deviceName).toBeUndefined();
    expect(search([seed])[0].provenance?.summary).not.toContain("Fictional desktop");
  });

  test("metadata budgets omit optional graph context instead of dropping a valid long-ID hit", () => {
    const seed = doc("long-id", { source: "archive:" + "a".repeat(300) });
    expect(search([seed])).toEqual([seed]);
    const moved = doc("moved");
    db.prepare("UPDATE documents SET source_id = ? WHERE id = ?").run(
      "archive:" + "b".repeat(300),
      moved.documentId,
    );
    expect(search([moved])).toEqual([moved]);
  });

  test("bounds copies, nodes, depth, metadata and summary with honest stops", () => {
    const seed = doc("seed");
    for (let n = 0; n < 10; n++) doc(`copy-${n}`);
    for (let n = 0; n < 5; n++) {
      doc(`chain-${n}`, { type: "note", body: `Reference ${n}.` });
      edge(n === 0 ? "seed" : `chain-${n - 1}`, `chain-${n}`, "references");
    }
    const provenance = search([seed], {
      maxCopies: 2,
      maxNodes: 3,
      maxDepth: 1,
      maxSummaryChars: 80,
    })[0].provenance!;
    expect(provenance.copies).toHaveLength(2);
    expect(provenance.paths.every((p) => p.documentIds.length <= 2)).toBe(true);
    expect(provenance.summary.length).toBeLessThanOrEqual(80);
    expect(provenance.stopReasons).toEqual(expect.arrayContaining(["copies", "depth", "summary"]));
    const tiny = search([seed], { maxNodes: 1, maxCopies: 8 })[0].provenance!;
    expect(tiny.copies).toHaveLength(1);
    expect(tiny.paths).toHaveLength(0);
    expect(tiny.stopReasons).toContain("nodes");
  });
});
