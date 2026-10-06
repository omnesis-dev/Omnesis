// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { createDatabase } from "../db.js";
import { resetUrlGraphRoles, setUrlGraphRoles } from "../url-graph-roles.js";
import { OMNESIS_CHAT_SOURCE_ID } from "../sources/omnesis-chat/ids.js";
import { cognitionAuthoredDocumentTypes } from "../brain/cognition-authored.js";
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
    created?: string;
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
    options.created ?? NOW,
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
  test("derived summaries respect the configured character budget", () => {
    const generated = doc("generated", { source: OMNESIS_CHAT_SOURCE_ID, type: "conversation" });
    db.prepare("UPDATE documents SET title = ? WHERE id = 'generated'").run("x".repeat(300));
    const context = search([generated], { maxSummaryChars: 40 })[0].provenance!;
    expect(context.summary).toHaveLength(40);
    expect(context.summary).toMatch(/^Omnesis context\./);
    expect(context.truncated).toBe(true);
    expect(context.stopReasons).toContain("summary");
  });

  test("derived file metadata cannot merge into or seed an original copy family", () => {
    const generated = doc("generated-file", { source: OMNESIS_CHAT_SOURCE_ID });
    const original = doc("original");
    const hits = search([generated, original]);
    expect(hits.map((hit) => hit.documentId)).toEqual(["generated-file", "original"]);
    expect(hits.map((hit) => hit.provenance?.copies.map((copy) => copy.documentId))).toEqual([
      ["generated-file"],
      ["original"],
    ]);
    expect(search([original])[0].provenance?.copies.map((copy) => copy.documentId)).toEqual([
      "original",
    ]);
  });

  test("derived off-pool files cannot consume the copy discovery allowance", () => {
    const original = doc("original");
    for (let n = 0; n < 12; n++) {
      doc(`generated-${n}`, { source: OMNESIS_CHAT_SOURCE_ID });
    }
    doc("later-original-copy", { source: "archive:another" });
    const context = search([original], { maxCopies: 2 })[0].provenance!;
    expect(context.copies.map((copy) => copy.documentId)).toEqual([
      "original",
      "later-original-copy",
    ]);
    expect(context.truncated).toBe(false);
  });

  test("generated answers do not crowd out the original sharing trail or make it a hub", () => {
    const agreement = doc("agreement");
    doc("sharing-message", { source: "messages:fictional", type: "conversation" });
    edge("sharing-message", "agreement");
    doc("catalogue", { body: BODY + " A catalogue with many independent references." });
    edge("agreement", "catalogue");
    for (let n = 0; n < 12; n++) {
      doc(`derived-${n}`, { source: OMNESIS_CHAT_SOURCE_ID, type: "conversation" });
      edge(`derived-${n}`, "agreement");
      doc(`item-${n}`, { body: BODY + ` Independent catalogue item ${n}.` });
      edge("catalogue", `item-${n}`);
    }
    // The registry's exclusive types remain derived even under another source.
    for (const type of cognitionAuthoredDocumentTypes()) {
      doc(`derived-type-${type}`, { source: "archive:fictional", type });
      edge(`derived-type-${type}`, "agreement");
    }
    const context = search([agreement], { fanout: 2 })[0].provenance!;
    expect(context.paths.map((path) => path.documentIds)).toEqual([
      ["agreement", "catalogue"],
      ["agreement", "sharing-message"],
    ]);
    expect(context.summary).toContain("is linked from Title sharing-message");
    expect(context.summary).not.toContain("derived-");
    expect(context.stopReasons).toEqual(["hub"]);
  });

  test("derived roots remain searchable without spending the source trail budget", () => {
    const generated = Array.from({ length: 3 }, (_, n) =>
      doc(`generated-${n}`, { source: OMNESIS_CHAT_SOURCE_ID, type: "conversation" }),
    );
    const agreement = doc("agreement");
    doc("sharing-message", { source: "messages:fictional", type: "conversation" });
    edge("sharing-message", "agreement");
    for (const hit of generated) edge(hit.documentId, "agreement");
    const inputs = [...generated, agreement];
    const hits = search(inputs, { topN: 1 });
    expect(hits.map((hit) => [hit.documentId, hit.chunkText])).toEqual(
      inputs.map((hit) => [hit.documentId, hit.chunkText]),
    );
    for (const hit of hits.slice(0, 3)) {
      expect(hit.provenance?.summary).toMatch(/^Omnesis context\./);
      expect(hit.provenance?.paths).toEqual([]);
    }
    expect(hits[3].provenance?.paths).toEqual([
      {
        documentIds: ["agreement", "sharing-message"],
        edges: ["inbound:url"],
        relations: ["is linked from"],
      },
    ]);
  });

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
    expect(hits[0].provenance?.summary).toContain("documents with matching extracted text");
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
      { documentIds: ["seed", "hub"], edges: ["outbound:references"], relations: ["references"] },
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
      { documentIds: ["seed", "target"], edges: ["outbound:contains"], relations: ["contains"] },
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

  test("containment prose distinguishes attachments from declared parent-child direction", () => {
    const parent = doc("parent", { type: "email", body: "A fictional container document." });
    const child = doc("child", { type: "attachment" });
    edge("child", "parent", "contains");
    expect(search([child])[0].provenance?.summary).toContain("is attached to Title parent");
    expect(search([parent])[0].provenance?.summary).toContain(
      "includes the attachment Title child",
    );
    expect(search([parent])[0].provenance?.paths[0].edges).toEqual(["inbound:contains"]);
    expect(search([child])[0].provenance?.paths[0].edges).toEqual(["outbound:contains"]);
  });

  test("edge aliases with different metadata cannot exhaust sparse neighbor probes", () => {
    const seed = doc("seed", { type: "note", body: "An invented source note." });
    doc("first-target", { type: "note", body: "First related note." });
    doc("second-target", { type: "note", body: "Second related note." });
    const insert = db.prepare(`INSERT INTO document_links
      (source_doc_id,link_type,raw_target,normalized_target,target_doc_id,metadata_json,created_at)
      VALUES ('seed','references',?,?,?,?,?)`);
    for (let n = 0; n < 40; n++)
      insert.run(
        `alias-${n}`,
        `alias-${n}`,
        "first-target",
        JSON.stringify({ role: `example-${n}` }),
        NOW,
      );
    edge("seed", "second-target", "references");
    const context = search([seed], { fanout: 2 })[0].provenance!;
    expect(context.paths.map((path) => path.documentIds.at(-1))).toEqual([
      "first-target",
      "second-target",
    ]);
    expect(context.stopReasons).not.toContain("hub");
    expect(context.paths.map((path) => path.relations)).toEqual([["references"], ["references"]]);
  });

  test("attachment role metadata explains a file-to-parent connection without inferring ownership", () => {
    const child = doc("child", { type: "file" });
    const parent = doc("parent", { type: "conversation", body: "A fictional parent." });
    edge("child", "parent", "contains");
    db.prepare("UPDATE document_links SET metadata_json = ? WHERE source_doc_id = 'child'").run(
      JSON.stringify({ role: "attachment" }),
    );
    expect(search([child])[0].provenance?.summary).toContain("is attached to Title parent");
    expect(search([parent])[0].provenance?.summary).toContain(
      "includes the attachment Title child",
    );
    expect(search([parent])[0].provenance?.summary).not.toContain("shared by");
  });

  test.each([
    ["contains", "contains", "is part of"],
    ["url", "links to", "is linked from"],
    ["references", "references", "is referenced by"],
    ["replies-to", "is a reply to", "has a reply in"],
    ["calendar-event", "has a calendar connection with", "has a calendar connection with"],
  ])("%s paths pair readable relations with preserved machine edges", (type, outward, inward) => {
    const first = doc("first", { type: "note", body: "A fictional starting note." });
    const second = doc("second", { type: "note", body: "A fictional related note." });
    edge("first", "second", type);
    const out = search([first])[0].provenance!;
    const back = search([second])[0].provenance!;
    expect(out.paths[0].edges).toEqual([`outbound:${type}`]);
    expect(out.paths[0].relations).toEqual([outward]);
    expect(back.paths[0].edges).toEqual([`inbound:${type}`]);
    expect(back.paths[0].relations).toEqual([inward]);
    expect(out.summary).toContain(`${outward} Title second`);
    expect(back.summary).toContain(`${inward} Title first`);
  });

  describe("threads", () => {
    // Stored thread links point every message at one arbitrary member, so a
    // long thread is a star around it.
    function thread(size: number): SearchResultItem[] {
      const messages = Array.from({ length: size }, (_, n) =>
        doc(`m${n + 1}`, {
          type: "email",
          body: `Fictional thread message ${n + 1}.`,
          extra: { threadId: "thread-1" },
          created: `2026-01-${String(n + 1).padStart(2, "0")}T09:00:00.000Z`,
        }),
      );
      for (const message of messages.slice(1)) edge(message.documentId, "m1", "part-of-thread");
      return messages;
    }

    test("a long thread is one neighbour, named by its latest message", () => {
      const [first] = thread(9);
      const provenance = search([first])[0].provenance!;
      expect(provenance.stopReasons).not.toContain("hub");
      expect(provenance.paths[0]).toEqual({
        documentIds: ["m1", "m9"],
        edges: ["outbound:part-of-thread"],
        relations: ["is in a 9-message conversation whose latest message is"],
      });
      expect(provenance.modelContext?.facts[0]).toBe(
        "[D1] is in a 9-message conversation whose latest message is [D2] and is in the same conversation as [D3], [D4], [D5], [D6] and [D7].",
      );
      // The newest messages, up to the fanout; the oldest of a long thread stay out.
      expect(provenance.paths.map((path) => path.documentIds.at(-1))).toEqual([
        "m9",
        "m8",
        "m7",
        "m6",
        "m5",
        "m4",
      ]);
    });

    test("a short thread is shown whole, so no message in its middle is hidden", () => {
      const messages = thread(4);
      const provenance = search([messages[3]])[0].provenance!;
      expect(provenance.paths).toEqual([
        {
          documentIds: ["m4", "m3"],
          edges: ["outbound:part-of-thread"],
          relations: ["is the latest of 4 messages in a conversation that also has"],
        },
        {
          documentIds: ["m4", "m2"],
          edges: ["outbound:part-of-thread"],
          relations: ["is in the same conversation as"],
        },
        {
          documentIds: ["m4", "m1"],
          edges: ["outbound:part-of-thread"],
          relations: ["is in the same conversation as"],
        },
      ]);
    });

    test("a thread with no other visible member adds no fact", () => {
      const [only] = thread(1);
      const hidden = hiddenSourceIdsToExclude()[0];
      doc("hidden-member", { source: hidden, extra: { threadId: "thread-1" } });
      expect(search([only])[0].provenance?.paths).toEqual([]);
    });

    test("reads a conversationId when no threadId is declared", () => {
      const members = [1, 2, 3].map((n) =>
        doc(`c${n}`, {
          type: "email",
          body: `Fictional conversation message ${n}.`,
          extra: { conversationId: "conv-1" },
          created: `2026-01-0${n}T09:00:00.000Z`,
        }),
      );
      expect(search([members[0]])[0].provenance?.paths.map((path) => path.documentIds)).toEqual([
        ["c1", "c3"],
        ["c1", "c2"],
      ]);
    });

    test("ignores a thread id that is not text", () => {
      const members = [1, 2].map((n) =>
        doc(`n${n}`, { type: "email", body: `Fictional numbered ${n}.`, extra: { threadId: 7 } }),
      );
      expect(search([members[0]])[0].provenance?.paths).toEqual([]);
    });

    test("member lookups use the thread index rather than scanning the source", () => {
      for (const field of ["threadId", "conversationId"]) {
        const plan = db
          .prepare(
            `EXPLAIN QUERY PLAN SELECT d.id, COUNT(*) OVER () AS n FROM documents d
             WHERE d.source_id = ? AND json_extract(d.metadata, '$.extra.${field}') = ?
             ORDER BY +d.source_created_at DESC, d.id DESC LIMIT 1`,
          )
          .all("archive:fictional", "thread-1") as Array<{ detail: string }>;
        expect(plan.map((row) => row.detail).join(" ")).toMatch(/USING INDEX idx_documents_/);
        expect(plan.map((row) => row.detail).join(" ")).not.toMatch(/source_id_created_at/);
      }
    });

    test("a thread counts once against the hub limit", () => {
      const [first] = thread(3);
      for (const n of [1, 2]) {
        doc(`ref-${n}`, { type: "note", body: `Fictional note ${n}.` });
        edge("m1", `ref-${n}`, "references");
      }
      expect(search([first], { fanout: 3 })[0].provenance?.stopReasons).not.toContain("hub");
      expect(search([first], { fanout: 2 })[0].provenance?.stopReasons).toContain("hub");
    });
  });

  describe("cleaned reference counts", () => {
    function referenced(): SearchResultItem {
      const target = doc("target", { type: "note", body: "A fictional much-linked note." });
      for (const n of [1, 2]) {
        doc(`citer-${n}`, { type: "note", body: `Fictional note ${n}.` });
        edge(`citer-${n}`, "target", "references");
      }
      doc("page", { type: "note", body: "A fictional page linking three times." });
      const insert = db.prepare(`INSERT INTO document_links
        (source_doc_id,link_type,raw_target,normalized_target,target_doc_id,created_at)
        VALUES ('page','url',?,?,'target',?)`);
      for (const n of [1, 2, 3]) insert.run(`u${n}`, `u${n}`, NOW);
      doc("same-phone", { type: "note", body: "A fictional note sharing a number." });
      edge("same-phone", "target", "shares-phone");
      doc("answer", { source: OMNESIS_CHAT_SOURCE_ID, type: "conversation" });
      edge("answer", "target", "cited");
      return { ...target, refCount: 8 };
    }

    test("count distinct visible documents over the followed links", () => {
      const [hit] = search([referenced()], { cleanRefCounts: true, minRefCount: 3 });
      expect(hit.refCount).toBe(3);
    });

    test("leave refCount untouched when the caller does not ask for it", () => {
      expect(search([referenced()])[0].refCount).toBe(8);
    });

    test("drop refCount when nothing visible links in", () => {
      const lone = { ...doc("lone"), refCount: 2 };
      expect(search([lone], { cleanRefCounts: true, minRefCount: 3 })[0]).not.toHaveProperty(
        "refCount",
      );
    });

    test("enrich a well-linked hit past the leading results", () => {
      const first = doc("first", { type: "note", body: "A fictional leading note." });
      const target = referenced();
      const [, walked] = search([first, target], { topN: 1, cleanRefCounts: true, minRefCount: 3 });
      expect(walked.provenance?.paths.length).toBeGreaterThan(0);
      const [, plain] = search([first, target], { topN: 1, cleanRefCounts: true, minRefCount: 4 });
      expect(plain.provenance).toBeUndefined();
      const [, off] = search([first, target], { topN: 1, cleanRefCounts: true, minRefCount: 0 });
      expect(off.provenance).toBeUndefined();
    });
  });

  test("well-linked hits past the leading ones share an allowance of topN", () => {
    const hits = [doc("lead", { type: "note", body: "A fictional leading note." })];
    for (const n of [1, 2, 3]) {
      hits.push(doc(`linked-${n}`, { type: "note", body: `Fictional linked note ${n}.` }));
      for (const m of [1, 2, 3]) {
        doc(`in-${n}-${m}`, { type: "note", body: `Fictional citer ${n}-${m}.` });
        edge(`in-${n}-${m}`, `linked-${n}`, "references");
      }
    }
    const walked = search(hits, { topN: 1, cleanRefCounts: true, minRefCount: 3 }).map(
      (hit) => (hit.provenance?.paths.length ?? 0) > 0,
    );
    expect(walked).toEqual([false, true, false, false]);
  });

  test("the cleaned count leaves out links from a URL hub source", () => {
    const target = doc("target", { type: "note", body: "A fictional linked page." });
    doc("history-day", { source: "browser-history:fictional", type: "note", body: "A day." });
    edge("history-day", "target", "url");
    setUrlGraphRoles("test", ["browser-history"], [], []);
    try {
      expect(search([target], { cleanRefCounts: true })[0]).not.toHaveProperty("refCount");
    } finally {
      resetUrlGraphRoles();
    }
  });

  describe("reference table", () => {
    test("labels are shared across hits and a neighbour that is a hit says so", () => {
      const first = doc("first", { type: "note", body: "A fictional first note." });
      const second = doc("second", { type: "note", body: "A fictional second note." });
      edge("first", "second", "references");
      const [a, b] = search([first, second]);
      expect(a.provenance?.modelContext?.facts).toContain(
        "Also in these search results: [D2] (result 2).",
      );
      expect(b.provenance?.modelContext?.documents[0]).toMatchObject({
        ref: "D2",
        documentId: "second",
      });
      expect(b.provenance?.modelContext?.facts).toEqual([
        "Also in these search results: [D1] (result 1).",
        "[D2] is referenced by [D1].",
      ]);
    });

    test("a copy collapsed into a result reads as that result", () => {
      const note = doc("note", { type: "note", body: "A fictional note linking to a file." });
      const file = doc("file-a");
      const copy = doc("file-b");
      edge("note", "file-b", "references");
      const [first] = search([note, file, copy]);
      expect(first.provenance?.modelContext?.facts[0]).toBe(
        "Also in these search results: [D2] (result 2).",
      );
    });

    test("which neighbours are results outlasts a tight fact budget", () => {
      const first = doc("first", { type: "note", body: "A fictional first note." });
      const second = doc("second", { type: "note", body: "A fictional second note." });
      edge("first", "second", "references");
      const facts = search([first, second], { maxSummaryChars: 60 })[0].provenance?.modelContext
        ?.facts;
      expect(facts).toEqual(["Also in these search results: [D2] (result 2)."]);
    });

    test("each row carries the document's date to the minute and its type", () => {
      const first = doc("first", { type: "email", created: "2026-03-04T05:06:07.890Z" });
      const [hit] = search([first]);
      expect(hit.provenance?.modelContext?.documents[0]).toMatchObject({
        date: "2026-03-04T05:06Z",
        type: "email",
      });
    });
  });

  test("readable multi-hop paths retain one relation per connection", () => {
    const first = doc("first", { type: "note", body: "First fictional note." });
    doc("second", { type: "note", body: "Second fictional note." });
    doc("third", { type: "note", body: "Third fictional note." });
    edge("first", "second", "references");
    edge("second", "third", "replies-to");
    expect(search([first])[0].provenance?.paths).toContainEqual({
      documentIds: ["first", "second", "third"],
      edges: ["outbound:references", "outbound:replies-to"],
      relations: ["references", "is a reply to"],
    });
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

  test.each(["brain-knowledge", "open-loops"])(
    "drops missing generated %s index hits, including long IDs",
    (source) => {
      const ordinary = doc("ordinary-stale");
      db.prepare("DELETE FROM documents WHERE id=?").run(ordinary.documentId);
      for (const documentId of ["missing-projection", "generated-".repeat(40)]) {
        expect(search([{ ...ordinary, documentId, sourceId: source }])).toEqual([]);
      }
      // A real deletion has a durable tombstone; only an unknown ordinary
      // index hit retains the legacy missing-row fallback.
      expect(search([ordinary])).toEqual([]);
      expect(search([{ ...ordinary, documentId: "unknown-ordinary-stale" }])).toHaveLength(1);
    },
  );

  test("checks authoritative privacy before optional long-ID graph fallback", () => {
    const hit = doc("long-projection-".repeat(24));
    db.prepare("UPDATE documents SET source_id='brain-knowledge' WHERE id=?").run(hit.documentId);
    expect(search([hit])).toEqual([]);
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
