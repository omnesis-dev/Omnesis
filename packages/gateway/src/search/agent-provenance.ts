// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Compact, deterministic graph evidence for trusted agent search results. */
import { GRAPH_CONTEXT_LINK_TYPES, computeContentHash } from "@omnesis/core";
import {
  cognitionAuthoredDocumentTypes,
  cognitionAuthoredSqlExclusion,
  isCognitionAuthoredDocument,
} from "../brain/cognition-authored.js";
import { sourceMatchesAnyPrefix, sourcePrefixPredicate } from "../data/source-addressing.js";
import { getUrlTraversalHubSources } from "../url-graph-roles.js";
import { hiddenSourceIdsToExclude } from "./hidden-sources.js";
import { provenanceModelContext } from "./provenance-model-context.js";
import type { SearchResultItem } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;
type Provenance = NonNullable<SearchResultItem["provenance"]>;
type Copy = Provenance["copies"][number];
type StopReason = Provenance["stopReasons"][number];
type ModelDocument = Omit<NonNullable<Provenance["modelContext"]>["documents"][number], "ref">;

export interface AgentSearchProvenanceOptions {
  limit: number;
  topN: number;
  /**
   * Agent ranking: every returned hit's `refCount` becomes its cleaned count —
   * the distinct visible documents linking to it over the links the walk
   * follows — and up to `topN` hits past the leading ones are enriched too,
   * in rank order, once that count reaches `minRefCount`. Off leaves
   * `refCount` untouched and enriches only the leading hits.
   */
  cleanRefCounts?: boolean;
  /** The cleaned count that enriches a hit past `topN`; 0 enriches only the leading hits. */
  minRefCount?: number;
  maxDepth: number;
  fanout: number;
  maxNodes: number;
  maxCopies: number;
  maxSummaryChars: number;
  /** Lazy exclusions are resolved in the graph read snapshot, after candidate generation. */
  excludeDocumentIds?: readonly string[] | (() => readonly string[]);
  /** Index snapshot hashes prevent stale chunks from claiming current identity. */
  indexedContentHashes?: Readonly<Record<string, string>>;
}

interface Doc {
  id: string;
  source_id: string;
  title: string;
  document_type: string | null;
  extracted_content_hash: string | null;
  content_hash: string;
  content_sample: string;
  low_signal: number | null;
  source_url: string | null;
  app_url: string | null;
  path: string | null;
  device_name: string | null;
  source_created_at: string | null;
  thread_id: string | null;
  conversation_id: string | null;
}

const EMPTY_HASH = computeContentHash("");
/**
 * The links the walk follows, highest priority first. Thread membership is
 * not among them: a thread's stored links point at an arbitrary member, so a
 * long thread would look like a hub. The walk asks the thread itself instead
 * (`threadStep`), which counts it as one neighbour and names its latest message.
 */
const EDGE_PRIORITY: readonly string[] = GRAPH_CONTEXT_LINK_TYPES.filter(
  (type) => type !== "part-of-thread",
);
const EDGE_SQL = EDGE_PRIORITY.map((type) => `'${type}'`).join(",");
/** Enough to separate a well-linked document from a hub, and cheap to count. */
const REFERENCE_COUNT_CEILING = 99;
/** The fields a source may use to name a document's thread, in the order link extraction reads them. */
const THREAD_FIELDS = ["threadId", "conversationId"] as const;

/** Attachment extraction points to its parent; declared containers point to their child. */
function relationPhrase(
  type: string,
  direction: string,
  from: Doc,
  to: Doc,
  role: string | null,
): string {
  const outbound = direction === "outbound";
  switch (type) {
    case "contains":
      if ((from.document_type === "attachment") !== (to.document_type === "attachment"))
        return from.document_type === "attachment" ? "is attached to" : "includes the attachment";
      if (role === "attachment") return outbound ? "is attached to" : "includes the attachment";
      return outbound ? "contains" : "is part of";
    case "url":
      return outbound ? "links to" : "is linked from";
    case "references":
      return outbound ? "references" : "is referenced by";
    case "replies-to":
      return outbound ? "is a reply to" : "has a reply in";
    case "calendar-event":
      return "has a calendar connection with";
    default:
      return "is connected to";
  }
}
const bounded = (n: number, lo: number, hi: number): number =>
  Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.trunc(n))) : lo;
const text = (s: string | null | undefined, max = 240): string | undefined =>
  s
    ? (() => {
        const clean = s.replace(/[\r\n\t]+/g, " ");
        return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
      })()
    : undefined;
const link = (s: string | null): string | undefined =>
  s && s.length <= 2048 && !/[\r\n\t]/.test(s) ? s : undefined;
/** A source timestamp to the minute, which is enough to order a trail. */
const minute = (s: string | null): string | undefined => {
  const time = s ? Date.parse(s) : Number.NaN;
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 16)}Z` : undefined;
};

// Text identity is narrower than byte identity. Empty/low-signal extraction
// must not turn unrelated binary files into one search result. File renderers
// commonly separate their descriptive header from extraction with a ruler.
function identityKey(doc: Doc | undefined): string | undefined {
  if (!doc || !["file", "attachment"].includes(doc.document_type ?? "")) return;
  if (isCognitionAuthoredDocument(doc.source_id, doc.document_type)) return;
  const hash = doc.extracted_content_hash;
  if (!hash || hash === EMPTY_HASH || doc.low_signal === 1) return;
  const sample = doc.content_sample.replace(/^[\s\S]*?\n---\n/, "");
  if (sample.replace(/\s/g, "").length < 40) return;
  return hash;
}

const DOC_COLUMNS = `d.id, d.source_id, substr(d.title, 1, 241) AS title, d.content_hash,
  json_extract(d.metadata, '$.documentType') AS document_type,
  d.extracted_content_hash, substr(d.content, 1, 4096) AS content_sample,
  json_extract(d.metadata, '$.lowSignal') AS low_signal,
  substr(COALESCE(d.source_url, json_extract(d.metadata, '$.sourceUrl')), 1, 2049) AS source_url,
  substr(json_extract(d.metadata, '$.appUrl'), 1, 2049) AS app_url,
  substr(json_extract(d.metadata, '$.extra.path'), 1, 241) AS path,
  substr(device.name, 1, 241) AS device_name, d.source_created_at,
  CASE WHEN json_type(d.metadata, '$.extra.threadId') = 'text'
    THEN json_extract(d.metadata, '$.extra.threadId') END AS thread_id,
  CASE WHEN json_type(d.metadata, '$.extra.conversationId') = 'text'
    THEN json_extract(d.metadata, '$.extra.conversationId') END AS conversation_id`;
const DOC_JOINS = `LEFT JOIN sources s ON s.id = d.source_id
  LEFT JOIN devices device ON device.id = CASE
    WHEN d.stream_id != '' THEN d.stream_id
    WHEN s.multi_device_mode = 'exclusive' AND json_extract(d.metadata, '$.extra.path') IS NOT NULL THEN s.device_id
    ELSE NULL END`;

function copyOf(doc: Doc): Copy {
  return {
    documentId: doc.id,
    sourceId: doc.source_id,
    title: text(doc.title),
    url: link(doc.source_url),
    appUrl: link(doc.app_url),
    deviceName: text(doc.device_name),
    path: text(doc.path),
  };
}

/** A reference-table row: the copy fields plus when and what, so a trail reads in order. */
function referenceOf(doc: Doc): ModelDocument {
  return {
    ...copyOf(doc),
    date: minute(doc.source_created_at),
    type: text(doc.document_type, 64),
  };
}

/** Group the ranked candidate pool before limiting, then enrich its top groups. */
export function enrichAgentSearch(
  db: Db,
  results: readonly SearchResultItem[],
  options: AgentSearchProvenanceOptions,
): SearchResultItem[] {
  const opts = {
    limit: bounded(options.limit, 1, 100),
    topN: bounded(options.topN, 0, 10),
    maxDepth: bounded(options.maxDepth, 1, 5),
    fanout: bounded(options.fanout, 1, 12),
    maxNodes: bounded(options.maxNodes, 1, 64),
    maxCopies: bounded(options.maxCopies, 1, 24),
    maxSummaryChars: bounded(options.maxSummaryChars, 1, 2000),
    minRefCount: bounded(options.minRefCount ?? 0, 0, 50),
  };
  const summarize = (fullSummary: string, reasons: Set<StopReason>): string => {
    if (fullSummary.length <= opts.maxSummaryChars) return fullSummary;
    reasons.add("summary");
    return `${fullSummary.slice(0, Math.max(0, opts.maxSummaryChars - 1))}…`;
  };
  // Resolve dynamic exclusions in the same snapshot as identity and paths.
  // A transcript may arrive while the asynchronous search lanes are running.
  return db.transaction(() => {
    const excluded = new Set(
      typeof options.excludeDocumentIds === "function"
        ? options.excludeDocumentIds()
        : (options.excludeDocumentIds ?? []),
    );
    const hidden = hiddenSourceIdsToExclude();
    const visible = (id: string, sourceId: string): boolean =>
      id.length <= 256 &&
      sourceId.length <= 256 &&
      !excluded.has(id) &&
      !sourceMatchesAnyPrefix(sourceId, hidden);
    const hiddenSql = sourcePrefixPredicate("d.source_id", hidden);
    const excludedIds = [...excluded];
    const visibleSql = `length(d.id) <= 256 AND length(d.source_id) <= 256 AND NOT ${hiddenSql.sql}${excludedIds.length ? ` AND d.id NOT IN (${excludedIds.map(() => "?").join(",")})` : ""}`;
    const visibleParams = [...hiddenSql.params, ...excludedIds];
    const hubs = sourcePrefixPredicate("d.source_id", [...getUrlTraversalHubSources()]);
    const derived = cognitionAuthoredSqlExclusion("d.source_id");
    const derivedTypes = cognitionAuthoredDocumentTypes();
    const derivedTypeSql = derivedTypes.length
      ? `AND COALESCE(json_extract(d.metadata, '$.documentType'), '') NOT IN (${derivedTypes.map(() => "?").join(",")})`
      : "";
    const load = db.prepare<[string], Doc>(
      `SELECT ${DOC_COLUMNS} FROM documents d ${DOC_JOINS} WHERE d.id = ?`,
    );
    const docs = new Map<string, Doc | undefined>();
    const get = (id: string): Doc | undefined => {
      if (!docs.has(id)) docs.set(id, load.get(id));
      return docs.get(id);
    };

    const groups: { hit: SearchResultItem; hash?: string; stale: boolean }[] = [];
    const seenIds = new Set<string>();
    const copyBudget = Math.min(opts.maxCopies, opts.maxNodes);
    const families = new Map<string, { members: Doc[]; truncated: boolean }>();
    for (const hit of results) {
      if (
        excluded.has(hit.documentId) ||
        sourceMatchesAnyPrefix(hit.sourceId, hidden) ||
        seenIds.has(hit.documentId)
      )
        continue;
      seenIds.add(hit.documentId);
      // Do not shorten addressable IDs, or remove an otherwise valid hit just
      // because it cannot fit the optional graph projection's metadata budget.
      if (hit.documentId.length > 256 || hit.sourceId.length > 256) {
        groups.push({ hit, stale: true });
        continue;
      }
      const current = get(hit.documentId);
      // Index metadata can lag a source move without a body/hash change.
      // The current corpus identity must also pass the visibility boundary.
      if (current && sourceMatchesAnyPrefix(current.source_id, hidden)) continue;
      if (current && (current.id.length > 256 || current.source_id.length > 256)) {
        groups.push({ hit, stale: true });
        continue;
      }
      const stale =
        options.indexedContentHashes !== undefined &&
        options.indexedContentHashes[hit.documentId] !== current?.content_hash;
      const hash = stale ? undefined : identityKey(current);
      if (hash && current) {
        const family = families.get(hash);
        if (family) {
          if (family.members.length < copyBudget) family.members.push(current);
          else family.truncated = true;
          continue;
        }
        families.set(hash, { members: [current], truncated: false });
      }
      groups.push({ hit, hash, stale });
    }
    const person = db.prepare<[string, number], { name: string; role: string }>(
      `SELECT DISTINCT substr(canonical.canonical_name, 1, 241) AS name, dp.role
       FROM document_people dp JOIN people p ON p.id = dp.person_id
       JOIN people canonical ON canonical.id = COALESCE(p.merged_into, p.id)
       WHERE dp.document_id = ? AND canonical.merged_into IS NULL AND canonical.is_self = 0
       AND dp.role IN ('sender', 'author', 'recipient', 'participant')
       ORDER BY CASE dp.role WHEN 'sender' THEN 0 WHEN 'author' THEN 1
         WHEN 'recipient' THEN 2 ELSE 3 END, canonical.id LIMIT ?`,
    );
    const adjacency = (direction: "outbound" | "inbound") => {
      const [match, other] =
        direction === "outbound"
          ? ["l.source_doc_id", "l.target_doc_id"]
          : ["l.target_doc_id", "l.source_doc_id"];
      const from = `FROM document_links l JOIN documents d ON d.id = ${other}
         WHERE ${match} = ? AND d.id != ? AND l.link_type IN (${EDGE_SQL})
         AND ${visibleSql} ${derived.sql ? `AND ${derived.sql}` : ""} ${derivedTypeSql}
         AND NOT (l.link_type = 'url' AND ${hubs.sql})`;
      return {
        degree: db.prepare<unknown[], { id: string }>(`SELECT DISTINCT d.id ${from} LIMIT ?`),
        edges: db.prepare<unknown[], { id: string; link_type: string; role: string | null }>(
          `SELECT d.id, l.link_type,
            MAX(CASE WHEN json_extract(l.metadata_json, '$.role') = 'attachment' THEN 'attachment' END) AS role
           ${from} GROUP BY d.id, l.link_type LIMIT ?`,
        ),
      };
    };
    const outbound = adjacency("outbound");
    const inbound = adjacency("inbound");
    const adjacencyArgs = (id: string): unknown[] => [
      id,
      id,
      ...visibleParams,
      ...derived.params,
      ...derivedTypes,
      ...hubs.params,
    ];
    // The cleaned reference count: distinct visible documents that link here
    // over the links the walk follows. Raw `refCount` also counts every agent
    // citation, shared phone number, browsing day and duplicate copy. Counting
    // stops at a ceiling, so a document linked thousands of times costs no more
    // than one linked a hundred times.
    const references = db.prepare<unknown[], { n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT DISTINCT d.id FROM document_links l
         JOIN documents d ON d.id = l.source_doc_id
         WHERE l.target_doc_id = ? AND d.id != ? AND l.link_type IN (${EDGE_SQL})
         AND ${visibleSql} ${derived.sql ? `AND ${derived.sql}` : ""} ${derivedTypeSql}
         AND NOT (l.link_type = 'url' AND ${hubs.sql}) LIMIT ${REFERENCE_COUNT_CEILING})`,
    );
    const referenceCount = (id: string): number => references.get(...adjacencyArgs(id))?.n ?? 0;
    // A thread is read through the partial (source_id, thread field) index,
    // with the same visibility boundary as every other neighbour. The unary
    // plus keeps the planner from preferring the source's date index, which
    // would scan the whole source to find one thread's members.
    const threadMembers = Object.fromEntries(
      THREAD_FIELDS.map((field) => [
        field,
        db.prepare<unknown[], { id: string; n: number }>(
          `SELECT d.id, COUNT(*) OVER () AS n FROM documents d
           WHERE d.source_id = ? AND json_extract(d.metadata, '$.extra.${field}') = ?
           AND ${visibleSql} ${derived.sql ? `AND ${derived.sql}` : ""} ${derivedTypeSql}
           ORDER BY +d.source_created_at DESC, d.id DESC LIMIT ?`,
        ),
      ]),
    ) as Record<
      (typeof THREAD_FIELDS)[number],
      Database.Statement<unknown[], { id: string; n: number }>
    >;
    /**
     * A document's thread as one neighbour: its newest other messages, up to
     * the fanout, the first named with the thread's size. A short thread is
     * shown whole, so a message in the middle of it is never hidden; a long
     * one shows its newest messages. Empty when the thread was already stepped
     * into on this walk or has no other visible member; the thread is marked
     * stepped into either way, so its other members never query it again.
     */
    const threadStep = (doc: Doc, seen: Set<string>): { id: string; relation: string }[] => {
      const field = doc.thread_id ? "threadId" : doc.conversation_id ? "conversationId" : null;
      const value = field === "threadId" ? doc.thread_id : doc.conversation_id;
      if (!field || !value) return [];
      const key = JSON.stringify([doc.source_id, field, value]);
      if (seen.has(key)) return [];
      seen.add(key);
      const rows = threadMembers[field].all(
        doc.source_id,
        value,
        ...visibleParams,
        ...derived.params,
        ...derivedTypes,
        opts.fanout + 1,
      );
      const size = rows[0]?.n ?? 0;
      if (size < 2) return [];
      const latest = rows[0]!.id === doc.id;
      return rows
        .filter((row) => row.id !== doc.id)
        .slice(0, opts.fanout)
        .map((row, index) => ({
          id: row.id,
          relation:
            index > 0
              ? "is in the same conversation as"
              : latest
                ? `is the latest of ${size} messages in a conversation that also has`
                : `is in a ${size}-message conversation whose latest message is`,
        }));
    };
    const roleCache = new Map<string, { labels: string; truncated: boolean }>();
    const describe = (doc: Doc, reasons: Set<StopReason>): string => {
      if (!roleCache.has(doc.id)) {
        const rows = person.all(doc.id, 5);
        roleCache.set(doc.id, {
          labels: rows
            .slice(0, 4)
            .map((p) => `${p.role}: ${text(p.name)}`)
            .join("; "),
          truncated: rows.length > 4 || rows.some((p) => p.name.length > 240),
        });
      }
      const roles = roleCache.get(doc.id)!;
      if (roles.truncated) reasons.add("summary");
      return `${text(doc.title) ?? doc.id} (${text(doc.source_id)})${roles.labels ? `, ${roles.labels}` : ""}`;
    };

    const returned = groups.slice(0, opts.limit);
    // Labels are shared across the whole result list, so a document reads the
    // same in every hit's facts and a neighbour that is itself a hit says so.
    // A copy collapsed into a result reads as that result.
    const ranks = new Map<string, number>();
    returned.forEach(({ hit, hash }, index) => {
      ranks.set(hit.documentId, index + 1);
      for (const member of hash ? (families.get(hash)?.members ?? []) : [])
        if (!ranks.has(member.id)) ranks.set(member.id, index + 1);
    });
    const shared = { refs: new Map<string, string>(), ranks };
    const counts = new Map(
      options.cleanRefCounts
        ? returned.map(({ hit }) => [hit.documentId, referenceCount(hit.documentId)])
        : [],
    );
    const withCount = (hit: SearchResultItem): SearchResultItem => {
      const count = counts.get(hit.documentId);
      if (count === undefined) return hit;
      const { refCount: _raw, ...rest } = hit;
      return count > 0 ? { ...rest, refCount: count } : rest;
    };
    let contextRank = 0;
    let connectedWalks = 0;
    return returned.map(({ hit: ranked, hash, stale }) => {
      const hit = withCount(ranked);
      if (stale) return hit;
      const seed = get(hit.documentId);
      if (!seed) return hit;
      const reasons = new Set<StopReason>();
      const recordClipping = (doc: Doc): void => {
        if (
          [doc.title, doc.device_name, doc.path].some((s) => s && s.length > 240) ||
          [doc.source_url, doc.app_url].some((s) => s && s.length > 2048)
        )
          reasons.add("summary");
      };
      recordClipping(seed);
      const copies: Copy[] = [copyOf(seed)];
      const seeds: Doc[] = [seed];
      if (hash) {
        // Validated ranked family members come first: an invalid off-pool row
        // must never hide the IDs of candidates already collapsed into this hit.
        const family = families.get(hash)!;
        const copyStop = copyBudget < opts.maxCopies ? "nodes" : "copies";
        if (family.truncated) reasons.add(copyStop);
        for (const member of family.members.slice(1)) {
          copies.push(copyOf(member));
          recordClipping(member);
          seeds.push(member);
        }
        // Exclude the retained family from the indexed off-pool probe so those
        // same rows cannot consume its remaining allowance a second time.
        const siblings = db.prepare<unknown[], Doc>(
          `SELECT ${DOC_COLUMNS} FROM documents d ${DOC_JOINS}
           WHERE d.extracted_content_hash = ?
           AND json_extract(d.metadata, '$.documentType') IN ('attachment', 'file')
           AND COALESCE(json_extract(d.metadata, '$.lowSignal'), 0) != 1
           AND ${visibleSql} ${derived.sql ? `AND ${derived.sql}` : ""}
           AND d.id NOT IN (${family.members.map(() => "?").join(",")}) LIMIT ?`,
        );
        const remaining = copyBudget - copies.length;
        const found = siblings.all(
          hash,
          ...visibleParams,
          ...derived.params,
          ...family.members.map((m) => m.id),
          remaining + 1,
        );
        if (found.length > remaining) reasons.add(copyStop);
        for (const sibling of found) {
          if (copies.length >= copyBudget) break;
          if (identityKey(sibling) !== hash) continue;
          copies.push(copyOf(sibling));
          recordClipping(sibling);
          seeds.push(sibling);
          docs.set(sibling.id, sibling);
        }
      }
      const paths: Provenance["paths"] = [];
      const stoppedHubs = new Set<string>();
      const modelContext = (derived = false): NonNullable<Provenance["modelContext"]> => {
        const ids = new Set([
          ...copies.map((copy) => copy.documentId),
          ...paths.flatMap((path) => path.documentIds),
          ...stoppedHubs,
        ]);
        const documents = new Map<string, ModelDocument>();
        for (const id of ids) {
          const doc = get(id);
          if (doc) documents.set(id, referenceOf(doc));
        }
        return provenanceModelContext(
          seed.id,
          copies,
          paths,
          documents,
          new Map([...roleCache].map(([id, role]) => [id, role.labels])),
          stoppedHubs,
          reasons,
          opts.maxSummaryChars,
          derived,
          shared,
        );
      };
      const lines: string[] = [];
      // Generated answers remain searchable, but their copied URLs are not
      // independent evidence of a file's journey and do not spend its budget.
      if (isCognitionAuthoredDocument(seed.source_id, seed.document_type)) {
        const summary = summarize(
          "Omnesis context. Its document links are not independent evidence of sharing.",
          reasons,
        );
        const context = modelContext(true);
        return {
          ...hit,
          provenance: {
            summary,
            copies,
            paths,
            modelContext: context,
            truncated: reasons.size > 0,
            stopReasons: [...reasons],
          },
        };
      }
      const leading = contextRank++ < opts.topN;
      // Well-linked hits past the leading ones share an allowance as large as
      // the leading set, so one search never walks more than twice `topN`.
      const connected =
        !leading &&
        opts.minRefCount > 0 &&
        connectedWalks < opts.topN &&
        (counts.get(hit.documentId) ?? 0) >= opts.minRefCount;
      if (connected) connectedWalks++;
      const includeContext = leading || connected;
      if (copies.length > 1)
        lines.push(`${copies.length} documents with matching extracted text are listed.`);
      if (!includeContext && copies.length === 1 && reasons.size === 0) return hit;
      lines.push(
        `${includeContext ? describe(seed, reasons) : `${text(seed.title)} (${text(seed.source_id)})`}.`,
      );
      for (const copy of copies) {
        if (copy.deviceName || copy.path)
          lines.push(
            `Indexed${copy.deviceName ? ` on ${copy.deviceName}` : ""}${copy.path ? ` at ${copy.path}` : ""}.`,
          );
      }
      const visited = new Set<string>();
      const threads = new Set<string>();
      type Step = { doc: Doc; ids: string[]; edges: string[]; relations: string[] };
      const queue: Step[] = [];
      for (const doc of includeContext ? seeds : []) {
        if (visited.size >= opts.maxNodes) {
          reasons.add("nodes");
          break;
        }
        visited.add(doc.id);
        queue.push({ doc, ids: [doc.id], edges: [], relations: [] });
      }
      /** Record one hop; false once the node budget is spent. */
      const step = (current: Step, doc: Doc, edge: string, relation: string): boolean => {
        if (visited.size >= opts.maxNodes || paths.length >= 24) {
          reasons.add("nodes");
          return false;
        }
        recordClipping(doc);
        visited.add(doc.id);
        const next = {
          doc,
          ids: [...current.ids, doc.id],
          edges: [...current.edges, edge],
          relations: [...current.relations, relation],
        };
        paths.push({ documentIds: next.ids, edges: next.edges, relations: next.relations });
        lines.push(`${text(current.doc.title)} ${relation} ${describe(doc, reasons)}.`);
        queue.push(next);
        return true;
      };
      for (let index = 0; index < queue.length; index++) {
        const current = queue[index];
        const args = adjacencyArgs(current.doc.id);
        const degree = new Set([
          ...outbound.degree.all(...args, opts.fanout + 1).map((r) => r.id),
          ...inbound.degree.all(...args, opts.fanout + 1).map((r) => r.id),
        ]);
        const thread = threadStep(current.doc, threads);
        // Degree counts documents, not parallel relations, and a whole thread
        // as one. The unsorted probe stops after fanout+1 distinct neighbours
        // and never loads their body.
        const threadNeighbour = thread.some((member) => !degree.has(member.id)) ? 1 : 0;
        if (degree.size + threadNeighbour > opts.fanout) {
          reasons.add("hub");
          stoppedHubs.add(current.doc.id);
          continue;
        }
        if (current.edges.length >= opts.maxDepth) {
          if ([...degree, ...thread.map((member) => member.id)].some((id) => !visited.has(id)))
            reasons.add("depth");
          continue;
        }
        // The thread comes first, so a message reached both ways reads as a
        // member of its conversation, with the conversation's size.
        let budget = true;
        for (const member of thread) {
          if (visited.has(member.id)) continue;
          const target = get(member.id);
          if (!target || !visible(target.id, target.source_id)) continue;
          budget = step(current, target, "outbound:part-of-thread", member.relation);
          if (!budget) break;
        }
        if (!budget) continue;
        // A sparse node has at most fanout*edge-types distinct rows in each
        // direction, so the full sparse relation set fits this SQL budget.
        const edgeCap = opts.fanout * EDGE_PRIORITY.length + 1;
        const rows = [
          ...outbound.edges.all(...args, edgeCap).map((r) => ({ ...r, direction: "outbound" })),
          ...inbound.edges.all(...args, edgeCap).map((r) => ({ ...r, direction: "inbound" })),
        ];
        const neighbors = new Map<string, (typeof rows)[number]>();
        for (const row of rows) {
          const prior = neighbors.get(row.id);
          if (
            !prior ||
            EDGE_PRIORITY.indexOf(row.link_type) < EDGE_PRIORITY.indexOf(prior.link_type)
          )
            neighbors.set(row.id, row);
        }
        const sorted = [...neighbors.values()].sort(
          (a, b) =>
            EDGE_PRIORITY.indexOf(a.link_type) - EDGE_PRIORITY.indexOf(b.link_type) ||
            a.id.localeCompare(b.id),
        );
        for (const row of sorted) {
          if (visited.has(row.id)) continue;
          const doc = get(row.id);
          if (!doc || !visible(doc.id, doc.source_id)) continue;
          const relation = relationPhrase(row.link_type, row.direction, current.doc, doc, row.role);
          if (!step(current, doc, `${row.direction}:${row.link_type}`, relation)) break;
        }
      }
      const summary = summarize(lines.join(" "), reasons);
      const context = modelContext();
      return {
        ...hit,
        provenance: {
          summary,
          copies,
          paths,
          modelContext: context,
          truncated: reasons.size > 0,
          stopReasons: [...reasons],
        },
      };
    });
  })();
}
