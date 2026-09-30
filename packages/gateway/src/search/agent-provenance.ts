// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Compact, deterministic graph evidence for trusted agent search results. */
import { computeContentHash } from "@omnesis/core";
import { sourceMatchesAnyPrefix, sourcePrefixPredicate } from "../data/source-addressing.js";
import { getUrlTraversalHubSources } from "../url-graph-roles.js";
import { hiddenSourceIdsToExclude } from "./hidden-sources.js";
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
         AND ${visibleSql} AND NOT (l.link_type = 'url' AND ${hubs.sql}) LIMIT ?`;
      return {
        degree: db.prepare<unknown[], { id: string }>(`SELECT DISTINCT d.id ${from}`),
        edges: db.prepare<unknown[], { id: string; link_type: string }>(
          `SELECT DISTINCT d.id, l.link_type ${from}`,
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

    return groups.slice(0, opts.limit).map(({ hit, hash, stale }, rank) => {
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
           AND ${visibleSql}
           AND d.id NOT IN (${family.members.map(() => "?").join(",")}) LIMIT ?`,
        );
        const remaining = copyBudget - copies.length;
        const found = siblings.all(
          hash,
          ...visibleParams,
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
      const lines: string[] = [];
      if (copies.length > 1)
        lines.push(`Matching extracted text: ${copies.length} indexed copies shown.`);
      if (rank >= opts.topN && copies.length === 1 && reasons.size === 0) return hit;
      lines.push(
        `${rank < opts.topN ? describe(seed, reasons) : `${text(seed.title)} (${text(seed.source_id)})`}.`,
      );
      for (const copy of copies) {
        if (copy.deviceName || copy.path)
          lines.push(
            `Indexed${copy.deviceName ? ` on ${copy.deviceName}` : ""}${copy.path ? ` at ${copy.path}` : ""}.`,
          );
      }
      const visited = new Set<string>();
      const queue: { doc: Doc; ids: string[]; edges: string[] }[] = [];
      for (const doc of rank < opts.topN ? seeds : []) {
        if (visited.size >= opts.maxNodes) {
          reasons.add("nodes");
          break;
        }
        visited.add(doc.id);
        queue.push({ doc, ids: [doc.id], edges: [] });
      }
      for (let index = 0; index < queue.length; index++) {
        const current = queue[index];
        const args = [current.doc.id, current.doc.id, ...visibleParams, ...hubs.params];
        const degree = new Set([
          ...outbound.degree.all(...args, opts.fanout + 1).map((r) => r.id),
          ...inbound.degree.all(...args, opts.fanout + 1).map((r) => r.id),
        ]);
        // Degree counts documents, not parallel relations. The unsorted probe
        // stops after fanout+1 distinct neighbours and never loads their body.
        if (degree.size > opts.fanout) {
          reasons.add("hub");
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
          };
          paths.push({ documentIds: next.ids, edges: next.edges });
          const relation =
            row.link_type === "url"
              ? row.direction === "inbound"
                ? "is linked from"
                : "links to"
              : row.link_type === "contains"
                ? "has a containment connection to"
                : `has an ${row.direction} ${row.link_type} connection to`;
          lines.push(`${text(current.doc.title)} ${relation} ${describe(doc, reasons)}.`);
          queue.push(next);
        }
      }
      const fullSummary = lines.join(" ");
      if (fullSummary.length > opts.maxSummaryChars) reasons.add("summary");
      const summary =
        fullSummary.length <= opts.maxSummaryChars
          ? fullSummary
          : `${fullSummary.slice(0, Math.max(0, opts.maxSummaryChars - 1))}…`;
      return {
        ...hit,
        provenance: {
          summary,
          copies,
          paths,
          truncated: reasons.size > 0,
          stopReasons: [...reasons],
        },
      };
    });
  })();
}
