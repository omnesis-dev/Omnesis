// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Build a chronological timeline of events from a graph payload.
 *
 * One TOP-LEVEL event per document vertex except attachments, which
 * nest inside their parent event as `event.attachments[]`. An email
 * with two PDFs attached produces ONE top-level event whose
 * `attachments` array has the two PDF events inside. The renderer then
 * draws the attachments as indented rows under the parent without
 * needing a separate bundle pass.
 *
 * Each event (top-level or attachment) carries:
 *   - `at`         — ISO timestamp from `sourceCreatedAt`
 *   - `kind`       — "seed" | "duplicate" | "similar" | "document"
 *   - `doc`        — {documentId, title, sourceId, sourceUrl, …}
 *   - `people`     — [{personId, name, role, isSelf}] grouped by role.
 *                    On nested attachments, the inherited buckets
 *                    ("to"/"with") and people already on the parent are
 *                    stripped so the indented row doesn't repeat what
 *                    the parent above already states.
 *   - `related`    — cross-document links (linkType verbatim, direction
 *                    in/out/peer). The "attached to parent" entry is
 *                    stripped from a nested attachment's related — the
 *                    visual indent already says that.
 *   - `attachments` — TrailEvent[] of documents whose `attachment` edge
 *                    points to this doc (the schema convention is
 *                    attachment-doc → container-doc). Empty array (not
 *                    omitted) when the event has no attachments.
 *
 * The function is source-agnostic. It enumerates the closed sets of
 * `link_type` values from `document_links` and `role` values from
 * `document_people` because those are shared-code enums defined in
 * `@omnesis/core` — they're not per-provider data. But it never
 * branches on `sourceId` or a specific source name.
 *
 * The input is the RAW graph (pre-collapse). Collapse simplifies the
 * spatial diagram; the timeline preserves each individual ingestion
 * so the story "same PDF arrived on three channels at three times"
 * shows up as three events.
 *
 * Returned top-level array is sorted oldest → newest; events with no
 * `sourceCreatedAt` fall to the bottom (`at: null`). Each parent's
 * `attachments[]` is sorted the same way.
 */

// link_types that express "this is the same thing on another channel"
// rather than a structural connection. They surface only relative to
// the seed (filtered below) so the timeline doesn't spam every event
// with the full dup-cluster adjacency.
const DUP_TYPES = new Set(["duplicate-content", "near-duplicate"]);

// duplicate-content is logically symmetric (A is a duplicate of B iff
// B is a duplicate of A) even though `document_links` stores it as
// directed. Treat it like near-duplicate when building the per-doc
// related list so both sides see the relationship.
const SYMMETRIC_DUP_TYPES = new Set(["duplicate-content", "same-resource"]);

// Verbs for the closed `link_type` enum from `document_links`. New
// types added to the schema later should get a row here — anything
// missing falls through to the generic "<linkType> →" rendering.
const LINK_TYPE_VERB = {
  "contains": "part of",
  "part-of-thread": "in same thread as",
  "replies-to": "replies to",
  "references": "links to",
  "succeeds": "follows",
  "accompanies": "alongside",
  "bookmarks": "bookmarks",
  "visited": "visited",
  "calendar-event": "matches event",
  "url": "cites",
  "duplicate-content": "duplicate of",
  "same-resource": "another representation of",
  "near-duplicate": "near-duplicate of",
};

// Role buckets, sourced from the closed `PersonRole` union in core.
// `agent` and `subject` are speculative future additions — they fall
// through to "involves" rendering today; nothing breaks if a new role
// shows up.
const ROLE_BUCKET = {
  sender: "by",
  author: "by",
  owner: "owned by",
  recipient: "to",
  attendee: "to",
  participant: "with",
  mentioned: "mentions",
  contact: "contact",
  editor: "edited by",
};

// Buckets that an attachment inherits from its parent doc (the email's
// recipients, the conversation's participants). The bundle pass
// strips them from children so the layout doesn't repeat what the
// parent above already states.
const INHERITED_ROLE_BUCKETS = new Set(["to", "with"]);

export function buildTimeline(graph) {
  if (!graph) return [];

  // Index people vertices by id so we can resolve role edges.
  const personsById = new Map();
  for (const v of graph.vertices) {
    if (v.kind === "person") personsById.set(v.id, v);
  }
  // Index document vertices similarly so we can resolve doc↔doc related-doc refs.
  const docsById = new Map();
  for (const v of graph.vertices) {
    if (v.kind === "document") docsById.set(v.id, v);
  }

  // Index analytics-row vertices that resolved to a record citation.
  // A row WITHOUT a `.record` (timeless table, empty semantic time, or an
  // unresolved table) is not a timeline record citation and is skipped
  // entirely — it never becomes an entity. The gateway derives `.record`
  // before building the timeline; this builder only places + dedups it.
  const recordRowsById = new Map();
  for (const v of graph.vertices) {
    if (v.kind === "analytics-row" && v.record) recordRowsById.set(v.id, v);
  }

  // Resolve each record row to its co-described document via the `same-entity`
  // edge. A document plus its same-entity row dedup to ONE timeline
  // entity: the row's record rides on the document event (which keeps
  // navigation), and the row is NOT emitted as its own entity. A record row
  // with no document in the walk stands alone as a record-only event below.
  //
  // Two dedup invariants, both keyed off the row's stable vertex id (=
  // recordKey, = analyticsRowKey):
  //   - One host doc per row: if several documents co-describe the same row
  //     (an event synced from two calendars), the record collapses onto a
  //     SINGLE host, appearing once rather than once per co-describing doc.
  //   - One record per host doc: a document hosts at most one record. A second
  //     record row whose only candidate host already carries a record is NOT
  //     dropped — it falls through to a standalone record-only event so no
  //     cited evidence is lost.
  const recordByDocVid = new Map();
  const boundRecordRowVids = new Set();
  // First pass: gather candidate host docs per row (a document in the walk).
  const candidateDocsByRowVid = new Map();
  for (const e of graph.edges) {
    if (e.type !== "same-entity") continue;
    const rowV = recordRowsById.get(e.from) ?? recordRowsById.get(e.to);
    if (!rowV) continue;
    const docVid = recordRowsById.has(e.from) ? e.to : e.from;
    if (!docsById.has(docVid)) continue;
    if (!candidateDocsByRowVid.has(rowV.id)) candidateDocsByRowVid.set(rowV.id, []);
    candidateDocsByRowVid.get(rowV.id).push(docVid);
  }
  // Second pass: assign each row to the first candidate host that hasn't
  // already claimed a record. A row that can't find a free host stays
  // unbound (rendered as its own record-only event).
  for (const [rowVid, candidateDocs] of candidateDocsByRowVid) {
    const row = recordRowsById.get(rowVid);
    const host = candidateDocs.find((docVid) => !recordByDocVid.has(docVid));
    if (host === undefined) continue;
    recordByDocVid.set(host, row.record);
    boundRecordRowVids.add(rowVid);
  }

  // Classify each doc vertex relative to the seeds so the renderer can
  // distinguish "input document" / "duplicate of an input doc" /
  // "similar document" / a plain unrelated doc. A direct
  // `duplicate-content` edge to ANY seed → exact duplicate; a direct
  // `near-duplicate` edge → similar. Source-agnostic: we only consume
  // shared-code link_type values.
  const seedIds = new Set(graph.seeds ?? []);
  const kindByDoc = new Map();
  for (const v of graph.vertices) {
    if (v.kind === "document") kindByDoc.set(v.id, seedIds.has(v.id) ? "seed" : "document");
  }
  for (const e of graph.edges) {
    if (e.type !== "duplicate-content" && e.type !== "near-duplicate") continue;
    const other = seedIds.has(e.from) ? e.to : seedIds.has(e.to) ? e.from : null;
    if (!other) continue;
    const current = kindByDoc.get(other);
    if (current === undefined || current === "seed") continue;
    // duplicate-content wins over near-duplicate if a vertex carries both.
    if (e.type === "duplicate-content") kindByDoc.set(other, "duplicate");
    else if (current !== "duplicate") kindByDoc.set(other, "similar");
  }

  // The seeds' documentIds are what we compare related items against
  // when filtering dup / near-dup mentions below — a related entry
  // pointing at ANY seed is kept so the timeline can express "this is
  // a duplicate of one of your input docs".
  const seedDocumentIds = new Set();
  for (const id of seedIds) {
    const v = docsById.get(id);
    if (v?.documentId) seedDocumentIds.add(v.documentId);
  }

  // Per-doc index: people incident on it + outbound related docs.
  const peopleByDoc = new Map();
  const relatedByDoc = new Map();
  for (const e of graph.edges) {
    const from = docsById.get(e.from) ?? personsById.get(e.from);
    const to = docsById.get(e.to) ?? personsById.get(e.to);
    if (!from || !to) continue;

    // doc ↔ person — record the role for the doc side.
    if (from.kind === "document" && to.kind === "person") {
      addPerson(peopleByDoc, from.id, to, e.type);
    } else if (from.kind === "person" && to.kind === "document") {
      addPerson(peopleByDoc, to.id, from, e.type);
    } else if (from.kind === "document" && to.kind === "document") {
      // doc ↔ doc. For a directed edge we put it under the `from` doc
      // ("from is attached to to"). For undirected edges (and for the
      // logically-symmetric duplicate-content even though the schema
      // stores it as directed) we surface from both sides so each
      // member's timeline mentions the relationship.
      //
      // `url` is a special case: it's surfaced on BOTH endpoints —
      // outbound on the citing doc ("cites X") and inbound on the
      // cited doc ("cited by X"). The pulled graph already suppresses URL
      // pivots through sources whose descriptors opt into traversal-hub
      // behavior, so any url edge that reaches this point is worth showing
      // from both sides.
      if (e.type === "url" && e.directed) {
        addRelated(relatedByDoc, from.id, {
          documentId: to.documentId,
          title: to.title,
          sourceId: to.sourceId,
          linkType: e.type,
          direction: "out",
        });
        addRelated(relatedByDoc, to.id, {
          documentId: from.documentId,
          title: from.title,
          sourceId: from.sourceId,
          linkType: e.type,
          direction: "in",
        });
        continue;
      }
      const symmetric = !e.directed || SYMMETRIC_DUP_TYPES.has(e.type);
      addRelated(relatedByDoc, from.id, {
        documentId: to.documentId,
        title: to.title,
        sourceId: to.sourceId,
        linkType: e.type,
        direction: e.directed ? "out" : "peer",
      });
      if (symmetric) {
        addRelated(relatedByDoc, to.id, {
          documentId: from.documentId,
          title: from.title,
          sourceId: from.sourceId,
          linkType: e.type,
          direction: "peer",
        });
      }
    }
  }

  // Assemble one event per document vertex (flat list — nesting is a
  // second pass below). Exact/near-duplicate mentions get filtered to "the
  // relationship to a SEED only" so a node with five duplicate-content
  // siblings doesn't print five repetitive lines on every card.
  const allEvents = [];
  const eventByDocId = new Map();
  for (const v of graph.vertices) {
    if (v.kind !== "document") continue;
    const people = peopleByDoc.get(v.id) ?? [];
    const allRelated = relatedByDoc.get(v.id) ?? [];
    const related = allRelated.filter((r) => {
      // `same-resource` explains why a fallback capture accompanies a
      // structured document, so it remains visible even when neither endpoint
      // is the seed. Exact/near duplicates retain the seed-only noise filter.
      if (!DUP_TYPES.has(r.linkType)) return true;
      return seedDocumentIds.has(r.documentId);
    });
    const eventKind = kindByDoc.get(v.id) ?? "document";
    // An exact duplicate of a seed has the same content by definition,
    // so its body-text mentions are necessarily the same as the seed's.
    // Strip them to reduce noise; the reader can infer them from the
    // seed card. Senders / recipients / owners / etc. stay — they can
    // legitimately differ between duplicates ingested through different
    // channels.
    const filteredPeople =
      eventKind === "duplicate"
        ? people.filter((p) => p.role !== "mentioned")
        : people;
    // When this document has a same-entity record row, the two dedup to
    // one entity — the record rides on the document event and the row is not
    // emitted separately. The event's `at` becomes the row's semantic time so
    // the record places chronologically by the real-world event time it
    // declares (the same instant a standalone record citation would use),
    // falling back to the doc's own ingest time when there's no bound record.
    const record = recordByDocVid.get(v.id);
    const ev = {
      // eventId is stable within the tool_result for projecting
      // annotations onto rows. Equal to doc.documentId today
      // (recomputable from any reference); the field is kept distinct
      // so the format can evolve (e.g. become a session-scoped hash)
      // without rewriting consumers.
      eventId: v.documentId,
      at: record ? record.semanticTime : (v.sourceCreatedAt ?? null),
      kind: eventKind,
      doc: {
        documentId: v.documentId,
        title: v.title,
        sourceId: v.sourceId,
        sourceUrl: v.sourceUrl,
        appUrl: v.appUrl,
        documentType: v.documentType,
        mimeType: v.mimeType,
      },
      people: filteredPeople.slice().sort(byRoleAndName),
      related: related.slice().sort(byRelatedKey),
      attachments: [],
    };
    if (record) ev.record = record;
    allEvents.push(ev);
    eventByDocId.set(v.documentId, ev);
  }

  // Emit a record-only event for every resolved record row that bound NO
  // document in the walk — it stands as its own point-in-time entity, placed by
  // its declared semantic time and interleaved with document events. A row that
  // deduped onto a document above is in `boundRecordRowVids` and skipped here.
  for (const [vid, v] of recordRowsById) {
    if (boundRecordRowVids.has(vid)) continue;
    allEvents.push({
      eventId: v.record.recordKey,
      at: v.record.semanticTime,
      kind: "record",
      record: v.record,
      people: [],
      related: [],
      attachments: [],
    });
  }

  // Nesting pass — every event whose `related[]` contains an outbound
  // `attachment` edge to another event in our list is moved into that
  // parent's `attachments[]`. The schema convention is
  // `source_doc=attachment, target_doc=container`, so an "out"
  // attachment edge points FROM the attachment TO its container. When
  // we nest, we strip the specific "attached to parent" entry from the
  // child's related (the indent already conveys it) and strip
  // inherited people (recipients/participants come from the container;
  // people the parent already lists in the same bucket would just
  // repeat).
  const parentByChild = new Map();
  for (const ev of allEvents) {
    const attRef = ev.related.find(
      (r) => r.linkType === "contains" && r.direction === "out",
    );
    if (!attRef) continue;
    const parent = eventByDocId.get(attRef.documentId);
    if (parent && parent !== ev) parentByChild.set(ev, parent);
  }
  for (const [child, parent] of parentByChild) {
    child.related = child.related.filter(
      (r) => !(r.linkType === "contains" && r.documentId === parent.doc.documentId),
    );
    const parentKeys = new Set(
      parent.people.map((p) => `${p.personId}|${ROLE_BUCKET[p.role] ?? "involves"}`),
    );
    child.people = child.people.filter((p) => {
      const bucket = ROLE_BUCKET[p.role] ?? "involves";
      if (INHERITED_ROLE_BUCKETS.has(bucket)) return false;
      return !parentKeys.has(`${p.personId}|${bucket}`);
    });
    parent.attachments.push(child);
  }

  const topLevel = allEvents.filter((ev) => !parentByChild.has(ev));

  // Sort top-level chronologically. Attachments sort within their
  // parent the same way. With attachments now nested, the old
  // "container before contained" tie-break is implicit: the parent
  // ALWAYS renders before its children, since children live inside
  // the parent's payload.
  topLevel.sort(byEventTime);
  for (const ev of topLevel) ev.attachments.sort(byEventTime);

  return topLevel;
}

function byEventTime(a, b) {
  if (!a.at && !b.at) return 0;
  if (!a.at) return 1;
  if (!b.at) return -1;
  return a.at.localeCompare(b.at);
}

function addPerson(map, docVertexId, personVertex, role) {
  if (!map.has(docVertexId)) map.set(docVertexId, []);
  const list = map.get(docVertexId);
  // Same person + same role → dedupe.
  if (list.some((p) => p.personId === personVertex.personId && p.role === role)) return;
  list.push({
    personId: personVertex.personId,
    name: personVertex.canonicalName,
    role,
    isSelf: !!personVertex.isSelf,
  });
}

function addRelated(map, docVertexId, item) {
  if (!map.has(docVertexId)) map.set(docVertexId, []);
  const list = map.get(docVertexId);
  if (
    list.some(
      (r) => r.documentId === item.documentId && r.linkType === item.linkType,
    )
  )
    return;
  list.push(item);
}

function byRoleAndName(a, b) {
  // Senders / authors first (the "by" bucket), then recipients, then
  // mentioned. Within a bucket: self first, then alphabetical.
  const ra = bucketPriority(a.role);
  const rb = bucketPriority(b.role);
  if (ra !== rb) return ra - rb;
  if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
  return (a.name ?? "").localeCompare(b.name ?? "");
}

function bucketPriority(role) {
  switch (role) {
    case "sender":
    case "author":
    case "owner":
      return 0;
    case "recipient":
    case "attendee":
    case "participant":
      return 1;
    case "mentioned":
      return 2;
    case "editor":
      return 3;
    case "contact":
      return 4;
    default:
      return 5;
  }
}

function byRelatedKey(a, b) {
  if (a.linkType !== b.linkType) return a.linkType.localeCompare(b.linkType);
  return (a.title ?? "").localeCompare(b.title ?? "");
}

/**
 * Verb phrase for a `link_type`. Falls back to the raw type string if
 * a new value shows up that isn't mapped here — UI still renders
 * sensibly without code changes.
 *
 * Direction-aware: `url` flips to "cited by" on inbound entries (the
 * cited doc's perspective). On outbound (the citing doc's side) it
 * stays "cites". The source-icon prefix carries the URL-ness so the
 * verb itself doesn't need to say "URL".
 */
export function phraseForLinkType(linkType, direction) {
  if (linkType === "url" && direction === "in") return "cited by";
  return LINK_TYPE_VERB[linkType] ?? linkType;
}

/**
 * Human-readable noun for the per-event kind classifier returned by
 * `buildTimeline`. Used by the timeline renderer to label each card
 * relative to the seed.
 */
export function nounForEventKind(kind) {
  switch (kind) {
    case "seed":
      return "the document";
    case "duplicate":
      return "duplicate";
    case "similar":
      return "similar document";
    case "document":
    default:
      return "document";
  }
}

/**
 * Group people by role-bucket label ("by", "to", "with", "mentions",
 * …) for rendering. Returns `[{ bucket, people }]` in display order.
 * Source-agnostic — only consumes the closed `role` enum.
 */
export function groupPeopleByBucket(people) {
  const groups = new Map();
  const order = [];
  for (const p of people) {
    const bucket = ROLE_BUCKET[p.role] ?? "involves";
    if (!groups.has(bucket)) {
      groups.set(bucket, []);
      order.push(bucket);
    }
    groups.get(bucket).push(p);
  }
  return order.map((bucket) => ({ bucket, people: groups.get(bucket) }));
}
