// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
import { buildTimeline, phraseForLinkType, groupPeopleByBucket, nounForEventKind } from "./graph-timeline.js";
import { describe, expect, it } from "vitest";

type TrailRecord = {
  recordKey: string;
  table: string;
  tableDisplayName: string;
  title: string;
  keyFields: { label: string; value: string | number | boolean | null }[];
  semanticTime: string;
  sourceId: string;
  sourceType: string;
  boundDocumentId: string | null;
  snapshot: Record<string, string | number | boolean | null>;
};
type Vertex = {
  id: string;
  kind: "document" | "person" | "analytics-row";
  depth: number;
  documentId?: string;
  title?: string;
  sourceId?: string;
  sourceUrl?: string;
  sourceCreatedAt?: string;
  personId?: string;
  canonicalName?: string;
  isSelf?: boolean;
  tableName?: string;
  rowPrimaryKey?: string;
  rowSourceId?: string;
  record?: TrailRecord;
};
type Edge = { from: string; to: string; type: string; directed: boolean };
type Graph = { seeds: string[]; vertices: Vertex[]; edges: Edge[]; truncated: boolean; stats: any };

function doc(id: string, at: string, title = `T-${id}`, sourceId = `src:${id}`): Vertex {
  return {
    id: `doc:${id}`,
    kind: "document",
    depth: 0,
    documentId: id,
    title,
    sourceId,
    sourceUrl: `https://x/${id}`,
    sourceCreatedAt: at,
  };
}
function person(id: string, name = `Name-${id}`, isSelf = false): Vertex {
  return { id: `person:${id}`, kind: "person", depth: 1, personId: id, canonicalName: name, isSelf };
}
function edge(from: string, to: string, type: string, directed = true): Edge {
  return { from, to, type, directed };
}
/**
 * An `analytics-row` vertex with a derived record citation (#757), as the
 * gateway trail port stamps onto it before building the timeline. `withRecord`
 * false simulates a row the gateway declined to resolve (timeless table / empty
 * semantic time) — it should never become a timeline entity.
 */
function recordRow(
  table: string,
  pk: string,
  semanticTime: string,
  opts: { withRecord?: boolean; boundDocumentId?: string | null; title?: string } = {},
): Vertex {
  const id = `row:${table}:${encodeURIComponent(pk)}`;
  const v: Vertex = {
    id,
    kind: "analytics-row",
    depth: 1,
    tableName: table,
    rowPrimaryKey: pk,
    rowSourceId: `${table.split("_")[0]}:acct`,
  };
  if (opts.withRecord !== false) {
    v.record = {
      recordKey: id,
      table,
      tableDisplayName: `${table} display`,
      title: opts.title ?? `Record ${pk}`,
      keyFields: [{ label: "Amount", value: "42.00" }],
      semanticTime,
      sourceId: `${table.split("_")[0]}:acct`,
      sourceType: table.split("_")[0]!,
      boundDocumentId: opts.boundDocumentId ?? null,
      snapshot: { id: pk, amount: "42.00" },
    };
  }
  return v;
}
function g(seed: string, vertices: Vertex[], edges: Edge[]): Graph {
  return {
    seeds: [`doc:${seed}`],
    vertices,
    edges,
    truncated: false,
    stats: { visited: vertices.length, fanoutCapHits: 0, maxDepthReached: 0, elapsedMs: 0 },
  };
}

const tl = buildTimeline as (graph: Graph) => any[];

describe("buildTimeline", () => {
  it("emits one event per document, sorted oldest → newest", () => {
    const events = tl(
      g(
        "a",
        [
          doc("a", "2024-01-15T10:00:00Z"),
          doc("b", "2024-02-01T09:00:00Z"),
          doc("c", "2024-01-10T12:00:00Z"),
        ],
        [],
      ),
    );
    expect(events).toHaveLength(3);
    expect(events.map((e: any) => e.doc.documentId)).toEqual(["c", "a", "b"]);
  });

  it("nests attachments inside the parent event, removing them from the top level", () => {
    // Parent + two attachments at the same timestamp. The new shape
    // puts the attachments inside `parent.attachments[]` so the
    // top-level events list has just the parent.
    const events = tl(
      g(
        "parent",
        [
          doc("parent", "2024-04-20T10:44:00Z"),
          doc("a1", "2024-04-20T10:44:00Z"),
          doc("a2", "2024-04-20T10:44:00Z"),
        ],
        [
          edge("doc:a1", "doc:parent", "contains", true),
          edge("doc:a2", "doc:parent", "contains", true),
        ],
      ),
    );
    expect(events.map((e: any) => e.doc.documentId)).toEqual(["parent"]);
    expect(events[0].attachments.map((a: any) => a.doc.documentId).sort()).toEqual(["a1", "a2"]);
  });

  it("top-level events without attachments carry an empty attachments[]", () => {
    const events = tl(g("a", [doc("a", "2024-01-15T10:00:00Z")], []));
    expect(events[0].attachments).toEqual([]);
  });

  it("a nested attachment drops 'by' people that already appear on its parent (same person + bucket)", () => {
    // Parent has You as sender; the attachment also has You as
    // sender. The "by You" on the attachment is redundant — drop it.
    const events = tl(
      g(
        "parent",
        [
          doc("parent", "2024-04-20T10:44:00Z"),
          doc("att", "2024-04-20T10:44:00Z"),
          person("me", "You", true),
        ],
        [
          edge("doc:att", "doc:parent", "contains", true),
          edge("doc:parent", "person:me", "sender", false),
          edge("doc:att", "person:me", "sender", false),
        ],
      ),
    );
    const parent = events.find((e: any) => e.doc.documentId === "parent")!;
    const child = parent.attachments.find((a: any) => a.doc.documentId === "att")!;
    expect(child.people).toEqual([]);
  });

  it("a nested attachment keeps 'by' people that DON'T match the parent's 'by' set", () => {
    const events = tl(
      g(
        "parent",
        [
          doc("parent", "2024-04-20T10:44:00Z"),
          doc("att", "2024-04-20T10:44:00Z"),
          person("alice", "Alice"),
          person("bob", "Bob"),
        ],
        [
          edge("doc:att", "doc:parent", "contains", true),
          edge("doc:parent", "person:alice", "sender", false),
          edge("doc:att", "person:bob", "sender", false),
        ],
      ),
    );
    const parent = events.find((e: any) => e.doc.documentId === "parent")!;
    const child = parent.attachments.find((a: any) => a.doc.documentId === "att")!;
    expect(child.people.map((p: any) => p.name)).toEqual(["Bob"]);
  });

  it("parent-match treats different buckets as distinct (parent 'by Alice' doesn't suppress child 'owned by Alice')", () => {
    const events = tl(
      g(
        "parent",
        [
          doc("parent", "2024-04-20T10:44:00Z"),
          doc("att", "2024-04-20T10:44:00Z"),
          person("alice", "Alice"),
        ],
        [
          edge("doc:att", "doc:parent", "contains", true),
          edge("doc:parent", "person:alice", "sender", false), // by bucket
          edge("doc:att", "person:alice", "owner", false), // owned by bucket
        ],
      ),
    );
    const parent = events.find((e: any) => e.doc.documentId === "parent")!;
    const child = parent.attachments.find((a: any) => a.doc.documentId === "att")!;
    // Different bucket → keep.
    expect(child.people.map((p: any) => `${p.role}-${p.name}`)).toEqual(["owner-Alice"]);
  });

  it("a nested attachment drops 'to'/'with' people — they're inherited from the parent", () => {
    // Parent has Alice as sender; the attachment has Charlie as
    // sender (different from parent so parent-match doesn't trigger)
    // plus Bob as recipient. The INHERITED rule should strip Bob
    // (recipient → "to" bucket); Charlie stays because the parent's
    // "by" bucket holds a different person.
    const events = tl(
      g(
        "parent",
        [
          doc("parent", "2024-04-20T10:44:00Z"),
          doc("att", "2024-04-20T10:44:00Z"),
          person("alice", "Alice"),
          person("bob", "Bob"),
          person("charlie", "Charlie"),
        ],
        [
          edge("doc:att", "doc:parent", "contains", true),
          edge("doc:parent", "person:alice", "sender", false),
          edge("doc:parent", "person:bob", "recipient", false),
          edge("doc:att", "person:charlie", "sender", false),
          edge("doc:att", "person:bob", "recipient", false),
        ],
      ),
    );
    const parent = events.find((e: any) => e.doc.documentId === "parent")!;
    const child = parent.attachments.find((a: any) => a.doc.documentId === "att")!;
    expect(child.people.map((p: any) => p.name)).toEqual(["Charlie"]);
  });

  it("a nested attachment drops its 'attached to <parent>' related line (the indent says it)", () => {
    const events = tl(
      g(
        "parent",
        [doc("parent", "2024-04-20T10:44:00Z"), doc("att", "2024-04-20T10:44:00Z")],
        [edge("doc:att", "doc:parent", "contains", true)],
      ),
    );
    const parent = events.find((e: any) => e.doc.documentId === "parent")!;
    const child = parent.attachments.find((a: any) => a.doc.documentId === "att")!;
    expect(child.related).toEqual([]);
  });

  it("nests structurally — an attachment with a later timestamp than its parent still nests", () => {
    // The structural attachment edge is the source of truth, not the
    // chronological position. An attachment that arrived (or was
    // ingested) two days after its container nests under the
    // container regardless. The intervening unrelated event remains
    // top-level on its own day.
    const events = tl(
      g(
        "parent",
        [
          doc("parent", "2024-04-20T10:44:00Z"),
          doc("intervening", "2024-04-21T10:00:00Z"),
          doc("att", "2024-04-22T10:00:00Z"),
        ],
        [edge("doc:att", "doc:parent", "contains", true)],
      ),
    );
    // Top level: just `parent` and `intervening` (the attachment
    // nested into the parent).
    expect(events.map((e: any) => e.doc.documentId)).toEqual(["parent", "intervening"]);
    const parent = events.find((e: any) => e.doc.documentId === "parent")!;
    expect(parent.attachments.map((a: any) => a.doc.documentId)).toEqual(["att"]);
  });

  it("two distinct parents each carry their own attachments", () => {
    const events = tl(
      g(
        "p1",
        [
          doc("p1", "2024-04-20T10:44:00Z"),
          doc("a1", "2024-04-20T10:44:00Z"),
          doc("p2", "2024-05-01T12:00:00Z"),
          doc("a2", "2024-05-01T12:00:00Z"),
        ],
        [
          edge("doc:a1", "doc:p1", "contains", true),
          edge("doc:a2", "doc:p2", "contains", true),
        ],
      ),
    );
    expect(events.map((e: any) => e.doc.documentId)).toEqual(["p1", "p2"]);
    expect(events[0].attachments.map((a: any) => a.doc.documentId)).toEqual(["a1"]);
    expect(events[1].attachments.map((a: any) => a.doc.documentId)).toEqual(["a2"]);
  });

  it("attachments are sorted chronologically within their parent", () => {
    const events = tl(
      g(
        "parent",
        [
          doc("parent", "2024-04-20T10:44:00Z"),
          doc("late", "2024-04-20T12:00:00Z"),
          doc("early", "2024-04-20T11:00:00Z"),
        ],
        [
          edge("doc:late", "doc:parent", "contains", true),
          edge("doc:early", "doc:parent", "contains", true),
        ],
      ),
    );
    const parent = events[0];
    expect(parent.attachments.map((a: any) => a.doc.documentId)).toEqual(["early", "late"]);
  });

  it("falls back to the bottom for events without a timestamp", () => {
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), { ...doc("b", ""), sourceCreatedAt: undefined }],
        [],
      ),
    );
    expect(events.map((e: any) => e.doc.documentId)).toEqual(["a", "b"]);
    expect(events[1].at).toBeNull();
  });

  it("attaches people to the right document via role edges", () => {
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), person("p", "Alice")],
        [edge("doc:a", "person:p", "sender", false)],
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0].people).toEqual([
      { personId: "p", name: "Alice", role: "sender", isSelf: false },
    ]);
  });

  it("sorts people within an event: senders/authors first, then recipients, then mentioned; self before others", () => {
    const events = tl(
      g(
        "a",
        [
          doc("a", "2024-01-15T10:00:00Z"),
          person("alice", "Alice"),
          person("bob", "Bob"),
          person("me", "You", true),
          person("eve", "Eve"),
        ],
        [
          edge("doc:a", "person:alice", "recipient", false),
          edge("doc:a", "person:bob", "sender", false),
          edge("doc:a", "person:me", "recipient", false),
          edge("doc:a", "person:eve", "mentioned", false),
        ],
      ),
    );
    const order = events[0].people.map((p: any) => p.name);
    // sender (Bob) first; then recipients with self (You) before Alice; then mentioned (Eve).
    expect(order).toEqual(["Bob", "You", "Alice", "Eve"]);
  });

  it("dedupes a person carrying the same role from multiple discoveries", () => {
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), person("p")],
        [edge("doc:a", "person:p", "sender", false), edge("doc:a", "person:p", "sender", false)],
      ),
    );
    expect(events[0].people).toHaveLength(1);
  });

  it("records the same person twice when discovered under different roles", () => {
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), person("p")],
        [
          edge("doc:a", "person:p", "sender", false),
          edge("doc:a", "person:p", "recipient", false),
        ],
      ),
    );
    expect(events[0].people).toHaveLength(2);
    const roles = events[0].people.map((p: any) => p.role).sort();
    expect(roles).toEqual(["recipient", "sender"]);
  });

  it("links related docs via directed edges only on the source side", () => {
    // a — email-thread → b. Event for `a` should mention b in related;
    // event for `b` should NOT carry the link in its `related` list
    // (you read the edge from a's perspective). Use email-thread
    // rather than attachment so the nesting pass doesn't move `a`
    // into `b.attachments` — we're testing the per-event related
    // resolution, not the nesting.
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), doc("b", "2024-01-20T10:00:00Z")],
        [edge("doc:a", "doc:b", "part-of-thread", true)],
      ),
    );
    const eventA = events.find((e: any) => e.doc.documentId === "a")!;
    const eventB = events.find((e: any) => e.doc.documentId === "b")!;
    expect(eventA.related).toEqual([
      { documentId: "b", title: "T-b", sourceId: "src:b", linkType: "part-of-thread", direction: "out" },
    ]);
    expect(eventB.related).toEqual([]);
  });

    it("surfaces `url` edges on BOTH endpoints — outbound 'cites' on the citing doc, inbound 'cited by' on the cited doc", () => {
    // `url` edges between graph vertices are shown from both sides
    // so the user can read the relationship from whichever event they
    // land on first. URL-hub source docs (chrome-bookmarks /
    // browser-history) are filtered at the BFS level so any url
    // edge reaching the timeline pass connects two real-source vertices
    // worth surfacing on both ends.
    const events = tl(
      g(
        "drive",
        [
          doc("drive", "2024-01-10T10:00:00Z"),
          doc("whatsapp", "2024-01-15T10:00:00Z"),
        ],
        [edge("doc:whatsapp", "doc:drive", "url", true)],
      ),
    );
    const eventDrive = events.find((e: any) => e.doc.documentId === "drive")!;
    const eventWa = events.find((e: any) => e.doc.documentId === "whatsapp")!;
    expect(eventWa.related).toEqual([
      {
        documentId: "drive",
        title: "T-drive",
        sourceId: "src:drive",
        linkType: "url",
        direction: "out",
      },
    ]);
    expect(eventDrive.related).toEqual([
      {
        documentId: "whatsapp",
        title: "T-whatsapp",
        sourceId: "src:whatsapp",
        linkType: "url",
        direction: "in",
      },
    ]);
  });

  it("the seed-vs-other near-duplicate surfaces on the non-seed side after filtering", () => {
    // The schema stores near-duplicate as undirected; we surface it on
    // both endpoints during expansion. The seed-only filter then drops
    // it from the seed's own card (the seed doesn't say "near-duplicate
    // of b" — b is not the input) but keeps it on b's card.
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), doc("b", "2024-01-20T10:00:00Z")],
        [edge("doc:a", "doc:b", "near-duplicate", false)],
      ),
    );
    const eventA = events.find((e: any) => e.doc.documentId === "a")!;
    const eventB = events.find((e: any) => e.doc.documentId === "b")!;
    expect(eventA.related).toEqual([]);
    expect(eventB.related).toHaveLength(1);
    expect(eventB.related[0]).toMatchObject({ documentId: "a", linkType: "near-duplicate" });
  });

  it("duplicate-content is treated symmetrically — non-seed side picks up the seed link even when stored as a→seed", () => {
    // The schema stores duplicate-content as directed; we treat it as
    // symmetric so both endpoints see the relationship. Combined with
    // the seed-only filter, this guarantees the non-seed event prints
    // "duplicate of <seed>" regardless of which way the link row was
    // recorded.
    const events = tl(
      g(
        "a", // a is the seed
        [doc("a", "2024-01-15T10:00:00Z"), doc("b", "2024-01-20T10:00:00Z")],
        [edge("doc:b", "doc:a", "duplicate-content", true)], // stored b→a
      ),
    );
    const eventA = events.find((e: any) => e.doc.documentId === "a")!;
    const eventB = events.find((e: any) => e.doc.documentId === "b")!;
    expect(eventA.related).toEqual([]);
    expect(eventB.related).toHaveLength(1);
    expect(eventB.related[0]).toMatchObject({ documentId: "a", linkType: "duplicate-content" });
  });

  it("same-resource is treated symmetrically and labelled as another representation", () => {
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), doc("b", "2024-01-20T10:00:00Z")],
        [edge("doc:a", "doc:b", "same-resource", true)],
      ),
    );
    const eventB = events.find((e: any) => e.doc.documentId === "b")!;
    expect(eventB.related).toHaveLength(1);
    expect(eventB.related[0]).toMatchObject({ documentId: "a", linkType: "same-resource" });
    expect(phraseForLinkType("same-resource")).toBe("another representation of");
  });

  it("keeps owner-to-capture context when a third transcript document is the seed", () => {
    const events = tl(
      g(
        "transcript",
        [
          doc("transcript", "2024-01-15T10:00:00Z"),
          doc("owner", "2024-01-20T10:00:00Z"),
          doc("capture", "2024-01-21T10:00:00Z"),
        ],
        [
          edge("doc:transcript", "doc:owner", "url", true),
          edge("doc:capture", "doc:owner", "same-resource", true),
        ],
      ),
    );
    const owner = events.find((event: any) => event.doc.documentId === "owner")!;
    const capture = events.find((event: any) => event.doc.documentId === "capture")!;

    expect(owner.related).toContainEqual(
      expect.objectContaining({ documentId: "capture", linkType: "same-resource" }),
    );
    expect(capture.related).toContainEqual(
      expect.objectContaining({ documentId: "owner", linkType: "same-resource" }),
    );
  });

  it("filters dup/near-dup mentions to the seed only — never lists dup-to-other-doc", () => {
    // Topology: seed a, plus b, c, d all duplicate-content of each
    // other. Each non-seed event's `related` should ONLY list the
    // relationship with `a` (the seed), never with the other dupes.
    const events = tl(
      g(
        "a",
        [
          doc("a", "2024-01-15T10:00:00Z"),
          doc("b", "2024-01-20T10:00:00Z"),
          doc("c", "2024-01-25T10:00:00Z"),
          doc("d", "2024-02-01T10:00:00Z"),
        ],
        [
          edge("doc:a", "doc:b", "duplicate-content", true),
          edge("doc:b", "doc:c", "duplicate-content", true),
          edge("doc:c", "doc:d", "duplicate-content", true),
          edge("doc:a", "doc:d", "near-duplicate", false),
        ],
      ),
    );
    const eventB = events.find((e: any) => e.doc.documentId === "b")!;
    const eventC = events.find((e: any) => e.doc.documentId === "c")!;
    const eventD = events.find((e: any) => e.doc.documentId === "d")!;
    // b's related is filtered down to "duplicate of a" only — the
    // b↔c edge gets dropped.
    expect(eventB.related).toHaveLength(1);
    expect(eventB.related[0]).toMatchObject({ documentId: "a", linkType: "duplicate-content" });
    // c has dup-content edges to b and d. Neither is the seed → empty.
    expect(eventC.related).toEqual([]);
    // d has dup-content to c (drop) and near-duplicate to a (keep).
    expect(eventD.related).toHaveLength(1);
    expect(eventD.related[0]).toMatchObject({ documentId: "a", linkType: "near-duplicate" });
  });

  it("keeps non-dup link types (email-thread, intra-source, etc.) regardless of which doc they point at", () => {
    // Note: we deliberately use non-attachment link types here. The
    // `attachment` link type ALSO triggers the nesting pass, which
    // would move `b` into `c.attachments[]` and strip the entry — a
    // separate behaviour tested above. This case asserts that the
    // dup-filter doesn't accidentally drop generic structural edges.
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), doc("b", "2024-01-20T10:00:00Z"), doc("c", "2024-01-25T10:00:00Z")],
        [
          edge("doc:b", "doc:c", "part-of-thread", true),
          edge("doc:b", "doc:c", "references", true),
        ],
      ),
    );
    const eventB = events.find((e: any) => e.doc.documentId === "b")!;
    expect(eventB.related).toHaveLength(2);
    const types = eventB.related.map((r: any) => r.linkType).sort();
    expect(types).toEqual(["part-of-thread", "references"]);
  });

  it("seed's own event shows no dup-relation lines (it IS the input doc)", () => {
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), doc("b", "2024-01-20T10:00:00Z"), doc("c", "2024-01-25T10:00:00Z")],
        [
          edge("doc:a", "doc:b", "duplicate-content", true),
          edge("doc:a", "doc:c", "near-duplicate", false),
        ],
      ),
    );
    const eventA = events.find((e: any) => e.doc.documentId === "a")!;
    expect(eventA.related).toEqual([]);
  });

  it("strips body-text mentions from exact-duplicate events (inferable from the seed)", () => {
    // A duplicate of the seed has the same content, so its body-text
    // mentions are the same as the seed's by definition. Hide them
    // to reduce noise; keep senders / recipients / owners.
    const events = tl(
      g(
        "a",
        [
          doc("a", "2024-01-15T10:00:00Z"),
          doc("b", "2024-02-01T10:00:00Z"),
          person("alice", "Alice"),
          person("bob", "Bob"),
        ],
        [
          edge("doc:a", "doc:b", "duplicate-content", true),
          edge("doc:b", "person:alice", "owner", false),
          edge("doc:b", "person:bob", "mentioned", false),
        ],
      ),
    );
    const eventB = events.find((e: any) => e.doc.documentId === "b")!;
    expect(eventB.kind).toBe("duplicate");
    expect(eventB.people.map((p: any) => p.name)).toEqual(["Alice"]);
  });

  it("keeps mentions on similar (non-exact) duplicates — content can differ", () => {
    const events = tl(
      g(
        "a",
        [
          doc("a", "2024-01-15T10:00:00Z"),
          doc("b", "2024-02-01T10:00:00Z"),
          person("bob", "Bob"),
        ],
        [
          edge("doc:a", "doc:b", "near-duplicate", false),
          edge("doc:b", "person:bob", "mentioned", false),
        ],
      ),
    );
    const eventB = events.find((e: any) => e.doc.documentId === "b")!;
    expect(eventB.kind).toBe("similar");
    expect(eventB.people.map((p: any) => p.name)).toEqual(["Bob"]);
  });

  it("classifies an exact duplicate of the seed as kind='duplicate'", () => {
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), doc("b", "2024-02-01T10:00:00Z")],
        [edge("doc:a", "doc:b", "duplicate-content", true)],
      ),
    );
    const eventB = events.find((e: any) => e.doc.documentId === "b")!;
    expect(eventB.kind).toBe("duplicate");
  });

  it("classifies a near-duplicate of the seed as kind='similar'", () => {
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), doc("b", "2024-02-01T10:00:00Z")],
        [edge("doc:a", "doc:b", "near-duplicate", false)],
      ),
    );
    const eventB = events.find((e: any) => e.doc.documentId === "b")!;
    expect(eventB.kind).toBe("similar");
  });

  it("kind='seed' for the input document itself", () => {
    const events = tl(g("a", [doc("a", "2024-01-15T10:00:00Z")], []));
    expect(events[0].kind).toBe("seed");
  });

  it("duplicate-content wins over near-duplicate when both edges connect to the seed", () => {
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), doc("b", "2024-02-01T10:00:00Z")],
        [
          edge("doc:a", "doc:b", "duplicate-content", true),
          edge("doc:a", "doc:b", "near-duplicate", false),
        ],
      ),
    );
    expect(events.find((e: any) => e.doc.documentId === "b")!.kind).toBe("duplicate");
  });

  it("unrelated docs keep kind='document'", () => {
    const events = tl(
      g(
        "a",
        [doc("a", "2024-01-15T10:00:00Z"), doc("b", "2024-02-01T10:00:00Z")],
        [edge("doc:a", "doc:b", "contains", true)],
      ),
    );
    expect(events.find((e: any) => e.doc.documentId === "b")!.kind).toBe("document");
  });
});

describe("phraseForLinkType", () => {
  it("returns canonical phrases for known types", () => {
    expect(phraseForLinkType("contains")).toBe("part of");
    expect(phraseForLinkType("part-of-thread")).toBe("in same thread as");
    expect(phraseForLinkType("calendar-event")).toBe("matches event");
  });

  it("falls through to the raw type for unknown values", () => {
    expect(phraseForLinkType("future-edge-type")).toBe("future-edge-type");
  });

  it("flips `url` to 'cited by' for inbound direction and 'cites' for outbound", () => {
    expect(phraseForLinkType("url")).toBe("cites");
    expect(phraseForLinkType("url", "out")).toBe("cites");
    expect(phraseForLinkType("url", "in")).toBe("cited by");
  });
});

describe("buildTimeline — record citations (#757)", () => {
  it("surfaces a record reachable from a seed with its identity + snapshot", () => {
    // A seed doc bound to its same-entity analytics row. The row resolved to a
    // record (it carries `.record`), so it surfaces on the trail.
    const seed = doc("a", "2024-01-15T10:00:00Z");
    const row = recordRow("strava_activities", "98765", "2024-01-15T08:30:00Z", {
      boundDocumentId: "a",
    });
    const events = tl(
      g("a", [seed, row], [edge("doc:a", row.id, "same-entity", false)]),
    );
    // Doc + same-entity row dedup to ONE entity.
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.doc.documentId).toBe("a");
    expect(ev.record).toBeDefined();
    expect(ev.record.recordKey).toBe(row.id);
    expect(ev.record.title).toBe("Record 98765");
    expect(ev.record.snapshot).toEqual({ id: "98765", amount: "42.00" });
    // The deduped event places by the row's semantic time, not the doc's
    // ingest time.
    expect(ev.at).toBe("2024-01-15T08:30:00Z");
  });

  it("a document + its same-entity row dedup to a single timeline entity (not two)", () => {
    const seed = doc("a", "2024-01-15T10:00:00Z");
    const row = recordRow("strava_activities", "98765", "2024-01-15T08:30:00Z", {
      boundDocumentId: "a",
    });
    const events = tl(
      g("a", [seed, row], [edge("doc:a", row.id, "same-entity", false)]),
    );
    // Exactly one entity — never a separate record-only event for the bound row.
    expect(events).toHaveLength(1);
    expect(events.filter((e: any) => e.kind === "record" && !e.doc)).toHaveLength(0);
  });

  it("a row reached via multiple same-entity edges dedups once", () => {
    // Two documents both co-describe the same row (e.g. an event synced from
    // two calendars). The row collapses onto the FIRST host; it never appears
    // twice and never spawns a record-only event.
    const a = doc("a", "2024-02-01T10:00:00Z");
    const b = doc("b", "2024-02-02T10:00:00Z");
    const row = recordRow("google_calendar_events", "evt-1", "2024-02-01T09:00:00Z", {
      boundDocumentId: "a",
    });
    const events = tl(
      g(
        "a",
        [a, b, row],
        [edge("doc:a", row.id, "same-entity", false), edge("doc:b", row.id, "same-entity", false)],
      ),
    );
    const withRecord = events.filter((e: any) => e.record);
    expect(withRecord).toHaveLength(1);
    expect(events.filter((e: any) => !e.doc)).toHaveLength(0);
    expect(events).toHaveLength(2); // doc a (carries record) + doc b
  });

  it("a second record bound to the same single doc falls back to its own entity (not dropped)", () => {
    // One document co-describes two distinct rows (two tables). The doc hosts
    // the first; the second isn't lost — it stands as its own record event.
    const seed = doc("a", "2024-02-10T10:00:00Z");
    const row1 = recordRow("strava_activities", "act-1", "2024-02-10T08:00:00Z", {
      boundDocumentId: "a",
      title: "Activity row",
    });
    const row2 = recordRow("strava_activity_laps", "lap-1", "2024-02-10T08:05:00Z", {
      boundDocumentId: "a",
      title: "Lap row",
    });
    const events = tl(
      g(
        "a",
        [seed, row1, row2],
        [
          edge("doc:a", row1.id, "same-entity", false),
          edge("doc:a", row2.id, "same-entity", false),
        ],
      ),
    );
    // Doc carries one record; the other surfaces standalone → 2 entities total.
    expect(events).toHaveLength(2);
    const docEv = events.find((e: any) => e.doc);
    const recordOnly = events.find((e: any) => !e.doc);
    expect(docEv.record).toBeDefined();
    expect(recordOnly).toBeDefined();
    expect(recordOnly.kind).toBe("record");
    // The two distinct rows are both represented (one on the doc, one alone).
    const titles = [docEv.record.title, recordOnly.record.title].sort();
    expect(titles).toEqual(["Activity row", "Lap row"]);
  });

  it("a record row with no bound document surfaces as its own entity", () => {
    const seed = doc("a", "2024-03-01T10:00:00Z");
    // A bank transaction row reachable from the seed but binding no document.
    const row = recordRow("bank_transactions", "acct:tx-9", "2024-03-01T07:00:00Z", {
      boundDocumentId: null,
      title: "Coffee — 4.50",
    });
    // No same-entity edge to any document (no boundDocument for this table).
    const events = tl(g("a", [seed, row], []));
    expect(events).toHaveLength(2);
    const recordOnly = events.find((e: any) => e.kind === "record");
    expect(recordOnly).toBeDefined();
    expect(recordOnly.doc).toBeUndefined();
    expect(recordOnly.record.title).toBe("Coffee — 4.50");
    expect(recordOnly.eventId).toBe(row.id);
    // Placed by its semantic time → sorts before the 10:00 doc.
    expect(events[0].kind).toBe("record");
  });

  it("a timeless row (no resolved record) never becomes a timeline entity", () => {
    const seed = doc("a", "2024-04-01T10:00:00Z");
    // The gateway declined to resolve this row (timeless table) → no `.record`.
    const timeless = recordRow("strava_athlete_stats", "athlete-1", "", {
      withRecord: false,
    });
    const events = tl(g("a", [seed, timeless], []));
    // Only the document — the timeless row is dropped entirely.
    expect(events).toHaveLength(1);
    expect(events[0].doc.documentId).toBe("a");
  });

  it("record-only events interleave with document events by semantic time", () => {
    const d1 = doc("a", "2024-05-01T10:00:00Z");
    const d2 = doc("b", "2024-05-03T10:00:00Z");
    const row = recordRow("bank_transactions", "acct:tx-1", "2024-05-02T12:00:00Z", {
      boundDocumentId: null,
    });
    const events = tl(g("a", [d1, d2, row], []));
    expect(events.map((e: any) => e.at)).toEqual([
      "2024-05-01T10:00:00Z",
      "2024-05-02T12:00:00Z",
      "2024-05-03T10:00:00Z",
    ]);
    expect(events[1].kind).toBe("record");
  });
});

describe("nounForEventKind", () => {
  it("renders the right noun per kind", () => {
    expect(nounForEventKind("seed")).toBe("the document");
    expect(nounForEventKind("duplicate")).toBe("duplicate");
    expect(nounForEventKind("similar")).toBe("similar document");
    expect(nounForEventKind("document")).toBe("document");
    expect(nounForEventKind("unknown" as any)).toBe("document");
  });
});

describe("groupPeopleByBucket", () => {
  it("groups people by their role bucket", () => {
    const groups = groupPeopleByBucket([
      { personId: "p1", name: "Alice", role: "sender", isSelf: false },
      { personId: "p2", name: "Bob", role: "recipient", isSelf: false },
      { personId: "p3", name: "Eve", role: "recipient", isSelf: false },
      { personId: "p4", name: "Mention", role: "mentioned", isSelf: false },
    ]);
    expect(groups.map((g) => g.bucket)).toEqual(["by", "to", "mentions"]);
    expect(groups[1].people.map((p) => p.name)).toEqual(["Bob", "Eve"]);
  });
});
