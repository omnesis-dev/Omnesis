// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Compact, deterministic graph evidence for trusted agent search results. */
import { computeContentHash } from "@omnesis/core";
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

export interface AgentSearchProvenanceOptions {
  limit: number;
  topN: number;
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
}

const EMPTY_HASH = computeContentHash("");
const EDGE_PRIORITY = [
  "contains",
  "calendar-event",
  "replies-to",
  "part-of-thread",
  "references",
  "url",
];
const EDGE_SQL = EDGE_PRIORITY.map((type) => `'${type}'`).join(",");

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
    case "part-of-thread":
      return "is in the same conversation as";
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
  substr(device.name, 1, 241) AS device_name`;
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

    let contextRank = 0;
    return groups.slice(0, opts.limit).map(({ hit, hash, stale }) => {
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
        const documents = new Map<string, Copy>();
        for (const id of ids) {
          const doc = get(id);
          if (doc) documents.set(id, copyOf(doc));
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
      const includeContext = contextRank++ < opts.topN;
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
      const queue: { doc: Doc; ids: string[]; edges: string[]; relations: string[] }[] = [];
      for (const doc of includeContext ? seeds : []) {
        if (visited.size >= opts.maxNodes) {
          reasons.add("nodes");
          break;
        }
        visited.add(doc.id);
        queue.push({ doc, ids: [doc.id], edges: [], relations: [] });
      }
      for (let index = 0; index < queue.length; index++) {
        const current = queue[index];
        const args = [
          current.doc.id,
          current.doc.id,
          ...visibleParams,
          ...derived.params,
          ...derivedTypes,
          ...hubs.params,
        ];
        const degree = new Set([
          ...outbound.degree.all(...args, opts.fanout + 1).map((r) => r.id),
          ...inbound.degree.all(...args, opts.fanout + 1).map((r) => r.id),
        ]);
        // Degree counts documents, not parallel relations. The unsorted probe
        // stops after fanout+1 distinct neighbours and never loads their body.
        if (degree.size > opts.fanout) {
          reasons.add("hub");
          stoppedHubs.add(current.doc.id);
          continue;
        }
        if (current.edges.length >= opts.maxDepth) {
          if ([...degree].some((id) => !visited.has(id))) reasons.add("depth");
          continue;
        }
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
          if (visited.size >= opts.maxNodes || paths.length >= 24) {
            reasons.add("nodes");
            break;
          }
          const doc = get(row.id);
          if (!doc || !visible(doc.id, doc.source_id)) continue;
          recordClipping(doc);
          visited.add(doc.id);
          const next = {
            doc,
            ids: [...current.ids, doc.id],
            edges: [...current.edges, `${row.direction}:${row.link_type}`],
            relations: [
              ...current.relations,
              relationPhrase(row.link_type, row.direction, current.doc, doc, row.role),
            ],
          };
          paths.push({ documentIds: next.ids, edges: next.edges, relations: next.relations });
          const relation = next.relations[next.relations.length - 1];
          lines.push(`${text(current.doc.title)} ${relation} ${describe(doc, reasons)}.`);
          queue.push(next);
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
