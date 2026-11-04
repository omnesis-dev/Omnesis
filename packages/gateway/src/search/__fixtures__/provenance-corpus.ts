// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A synthetic, deterministic corpus for agent search provenance: documents in
 * conversations of every size, copy families, link hubs, deep reference
 * chains, generated and hidden documents, deleted and missing hits, and the
 * people on them. Every name, address and body is invented. `scale` 0 builds
 * no documents (only a device and a source row), so its queries hold just a
 * missing hit; each further unit adds about three hundred documents.
 */

import { computeContentHash } from "@omnesis/core";
import { OMNESIS_CHAT_SOURCE_ID } from "../../sources/omnesis-chat/ids.js";
import { cognitionAuthoredDocumentTypes } from "../../brain/cognition-authored.js";
import { hiddenSourceIdsToExclude } from "../hidden-sources.js";
import type { ExternalDocumentKey } from "../agent-provenance.js";
import type { SearchResultItem } from "../types.js";
import type Database from "better-sqlite3";

const NOW = "2026-03-01T09:00:00.000Z";
/** A source whose URL links the walk treats as a hub; declare it before searching. */
export const CORPUS_HUB_SOURCE = "bookmarks:example";
const FIRST_NAMES = ["Maya", "Jamie", "David", "Sarah", "Priya", "Owen", "Lena", "Tomas"];
const LAST_NAMES = ["Reeves", "Lopez", "Lin", "Mendez", "Okafor", "Varga", "Holm", "Ito"];
const TOPICS = [
  "garden shelter specification",
  "quarterly budget review",
  "marathon entry form",
  "heart-rate trend summary",
  "studio lease renewal",
  "conference travel plan",
  "roof repair estimate",
  "volunteer rota",
];

export interface ProvenanceCorpus {
  /** Ranked hit lists, one per query, in the shape the candidate core hands to finalize. */
  queries: SearchResultItem[][];
  /** The index snapshot's content hash per document, with some deliberately stale. */
  indexedContentHashes: Record<string, string>;
  /** Documents an agent conversation would exclude, by the source identity each carries. */
  excludeExternalDocuments: ExternalDocumentKey[];
}

/** A small deterministic generator, so a scale always builds the same corpus. */
function prng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function buildProvenanceCorpus(
  db: Database.Database,
  scale: number,
  seed = 7,
): ProvenanceCorpus {
  const random = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const hits = new Map<string, SearchResultItem>();
  const hashes: Record<string, string> = {};
  const insertDoc = db.prepare(
    `INSERT INTO documents
      (id,provider_id,source_id,external_id,stream_id,title,content,content_hash,extracted_content_hash,
       metadata,source_created_at,source_updated_at,ingested_at,updated_at)
     VALUES (?,'example',?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO document_links
      (source_doc_id,link_type,raw_target,normalized_target,target_doc_id,created_at,metadata_json)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const insertPerson = db.prepare(
    `INSERT OR IGNORE INTO people (id,canonical_name,source,first_seen,last_seen,created_at,updated_at,is_self)
     VALUES (?,?,'example',?,?,?,?,?)`,
  );
  const insertRole = db.prepare(
    "INSERT OR IGNORE INTO document_people (document_id,person_id,role) VALUES (?,?,?)",
  );
  let created = Date.parse(NOW);
  const doc = (
    id: string,
    options: {
      source: string;
      type: string;
      body: string;
      title?: string;
      extra?: Record<string, unknown>;
      extractedHash?: string;
      lowSignal?: boolean;
      stream?: string;
      sourceUrl?: string;
    },
  ): SearchResultItem => {
    created -= 61_000;
    const at = new Date(created).toISOString();
    const hash = computeContentHash(options.body);
    const metadata = {
      documentType: options.type,
      sourceUrl: options.sourceUrl ?? `https://example.org/${encodeURIComponent(id)}`,
      ...(options.lowSignal ? { lowSignal: true } : {}),
      ...(options.extra ? { extra: options.extra } : {}),
    };
    insertDoc.run(
      id,
      options.source,
      id,
      options.stream ?? "",
      options.title ?? `${pick(TOPICS)} ${id}`,
      options.body,
      hash,
      options.extractedHash ?? hash,
      JSON.stringify(metadata),
      at,
      at,
      NOW,
      NOW,
    );
    hashes[id] = hash;
    return {
      documentId: id,
      sourceId: options.source,
      title: options.title ?? id,
      documentType: options.type,
      sourceCreatedAt: at,
      chunkText: options.body.slice(0, 200),
      score: random(),
    };
  };
  const link = (from: string, to: string, type: string, attachment = false): void => {
    insertLink.run(
      from,
      type,
      to,
      to,
      to,
      NOW,
      attachment ? JSON.stringify({ role: "attachment" }) : null,
    );
  };
  const people = Array.from({ length: 40 }, (_, n) => {
    const id = `person-${n}`;
    insertPerson.run(
      id,
      `${FIRST_NAMES[n % FIRST_NAMES.length]} ${LAST_NAMES[Math.floor(n / FIRST_NAMES.length) % LAST_NAMES.length]}`,
      NOW,
      NOW,
      NOW,
      NOW,
      n === 0 ? 1 : 0,
    );
    return id;
  });
  const roles = (documentId: string): void => {
    const count = 1 + Math.floor(random() * 6);
    for (let n = 0; n < count; n++)
      insertRole.run(
        documentId,
        pick(people),
        pick(["sender", "author", "recipient", "participant", "mentioned"]),
      );
  };
  const body = (topic: string, n: number): string =>
    `An invented note about the ${topic}, revision ${n}, listing materials, dates and owners in enough words to count as text.`;

  const pools = {
    messages: [] as SearchResultItem[],
    files: [] as SearchResultItem[],
    notes: [] as SearchResultItem[],
    generated: [] as SearchResultItem[],
    hubTargets: [] as SearchResultItem[],
  };
  db.transaction(() => {
    db.prepare(
      "INSERT OR IGNORE INTO devices (id,name,kind,paired_at) VALUES ('device-a','Example laptop','collector',1)",
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO sources (id,type,account_id,device_id,multi_device_mode,created_at,updated_at)
       VALUES ('files:example','files','example','device-a','exclusive',1,1)`,
    ).run();
    if (scale <= 0) return;
    // Conversations: a few very long ones, which make the walk count a whole
    // thread, and many short ones.
    const threadSizes = [
      ...Array.from({ length: 3 }, () => 150 * scale),
      ...Array.from({ length: 20 * scale }, () => 2 + Math.floor(random() * 6)),
    ];
    threadSizes.forEach((size, t) => {
      const field = t % 2 === 0 ? "threadId" : "conversationId";
      const source = field === "threadId" ? "mail:example" : "chat:example";
      for (let m = 0; m < size; m++) {
        const id = `msg-${t}-${m}`;
        const hit = doc(id, {
          source,
          type: field === "threadId" ? "email" : "message",
          body: body(pick(TOPICS), m),
          extra: { [field]: `thread-${t}` },
        });
        roles(id);
        if (m > 0 && random() < 0.5) link(id, `msg-${t}-${m - 1}`, "replies-to");
        pools.messages.push(hit);
      }
    });
    // Copy families: a file and its copies on other sources and as
    // attachments, sharing extracted text.
    for (let f = 0; f < 15 * scale; f++) {
      const text = body(`file family ${f}`, f);
      const extractedHash = computeContentHash(text);
      const copies = 1 + Math.floor(random() * 12);
      for (let c = 0; c < copies; c++) {
        const id = `file-${f}-${c}`;
        const attachment = c > 0 && random() < 0.4;
        const hit = doc(id, {
          source: c % 3 === 0 ? "files:example" : c % 3 === 1 ? "drive:example" : "mail:example",
          type: attachment ? "attachment" : "file",
          body: `# Example file header\n---\n${text}`,
          extractedHash,
          ...(c % 3 === 0 ? { extra: { path: `~/Documents/example-${f}-${c}.pdf` } } : {}),
          ...(random() < 0.05 ? { lowSignal: true } : {}),
        });
        if (attachment && pools.messages.length > 0)
          link(id, pick(pools.messages).documentId, "contains", true);
        pools.files.push(hit);
      }
    }
    // Reference chains deeper than the walk's depth budget.
    for (let r = 0; r < 10 * scale; r++) {
      const length = 2 + Math.floor(random() * 6);
      for (let n = 0; n < length; n++) {
        const id = `note-${r}-${n}`;
        const hit = doc(id, { source: "notes:example", type: "note", body: body("chain", n) });
        roles(id);
        if (n > 0) link(`note-${r}-${n - 1}`, id, "references");
        pools.notes.push(hit);
      }
    }
    // Hubs: documents linked from far more documents than the fanout.
    for (let h = 0; h < 4 * scale; h++) {
      const id = `hub-${h}`;
      const hit = doc(id, { source: "wiki:example", type: "note", body: body("index page", h) });
      pools.hubTargets.push(hit);
      const inbound = 10 + Math.floor(random() * 120);
      for (let n = 0; n < inbound; n++)
        link(pick([...pools.messages, ...pools.notes]).documentId, id, pick(["url", "references"]));
    }
    // Bookmarks whose URL links are hub links the walk never follows.
    for (let b = 0; b < 5 * scale; b++) {
      const id = `bookmark-${b}`;
      doc(id, { source: CORPUS_HUB_SOURCE, type: "bookmark", body: body("bookmark", b) });
      link(id, pick(pools.files).documentId, "url");
    }
    // Generated answers and hidden mirrors that cite ordinary documents.
    const hidden = hiddenSourceIdsToExclude()[0];
    for (let g = 0; g < 8 * scale; g++) {
      const id = `generated-${g}`;
      const hit = doc(id, {
        source: OMNESIS_CHAT_SOURCE_ID,
        type: "conversation",
        body: body("generated answer", g),
      });
      link(id, pick(pools.files).documentId, "url");
      link(id, pick(pools.messages).documentId, "references");
      pools.generated.push(hit);
      if (hidden) {
        const mirror = `hidden-${g}`;
        doc(mirror, { source: hidden, type: "open-loop", body: body("hidden mirror", g) });
        link(mirror, pick(pools.notes).documentId, "references");
      }
    }
    for (const type of cognitionAuthoredDocumentTypes()) {
      const id = `derived-${type}`;
      doc(id, { source: "notes:example", type, body: body("derived", 0) });
      link(id, pick(pools.notes).documentId, "references");
    }
    // Random cross links, priority-mixed, including calendar connections.
    const linkable = [...pools.messages, ...pools.files, ...pools.notes];
    for (let n = 0; n < 60 * scale; n++)
      link(
        pick(linkable).documentId,
        pick(linkable).documentId,
        pick(["url", "references", "contains", "calendar-event", "replies-to"]),
      );
    // Deleted documents keep their row but carry a durable tombstone.
    for (const hit of pools.notes.slice(0, Math.max(1, scale)))
      db.prepare(
        "INSERT OR REPLACE INTO knowledge_source_revisions (document_id,content_hash,deleted,updated_at) VALUES (?,?,1,1)",
      ).run(hit.documentId, hashes[hit.documentId]);
    // A partitioned stream names its contributing device.
    db.prepare(
      "UPDATE documents SET stream_id='device-a' WHERE id IN (SELECT id FROM documents WHERE source_id='files:example' LIMIT 20)",
    ).run();
  })();

  const all = [
    ...pools.messages,
    ...pools.files,
    ...pools.notes,
    ...pools.generated,
    ...pools.hubTargets,
  ];
  for (const hit of all) hits.set(hit.documentId, hit);
  // A few index snapshots lag the corpus.
  for (const hit of pools.files.slice(0, 3 * Math.max(1, scale)))
    hashes[hit.documentId] = computeContentHash("an earlier revision");
  const missing = (n: number): SearchResultItem => ({
    documentId: `missing-${n}`,
    sourceId: "notes:example",
    title: `Missing ${n}`,
    documentType: "note",
    sourceCreatedAt: NOW,
    chunkText: "An index entry whose document is gone.",
    score: 0.1,
  });
  // Each query mixes the leading members of long conversations, copies, hubs,
  // chain notes, generated answers, deleted and missing hits.
  const queries = Array.from({ length: 24 }, (_, q) => {
    const list: SearchResultItem[] = [];
    if (all.length > 0) {
      // A message from each long conversation leads, as when an agent asks
      // about a busy group chat.
      for (let t = 0; t < 3; t++) {
        const member = hits.get(`msg-${t}-${(q * 7 + t) % (150 * scale)}`);
        if (member) list.push(member);
      }
      for (let n = list.length; n < 59; n++) list.push(pick(all));
    }
    list.push(missing(q));
    return list.map((hit, rank) => ({ ...hit, score: 1 - rank / 100 }));
  });
  return {
    queries,
    indexedContentHashes: hashes,
    excludeExternalDocuments: [...pools.generated.slice(0, 1), ...pools.messages.slice(1, 2)].map(
      (hit) => ({ providerId: "example", sourceId: hit.sourceId, externalId: hit.documentId }),
    ),
  };
}
