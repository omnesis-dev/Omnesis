#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { defineCommand, runMain } from "citty";
import { DupeStore, defaultDupeDbPath } from "../store/repository.js";
import { isExactDupe, isSameThread, type FilterDocMeta } from "./edge-filters.js";
import { gatePair, type PairScores, type GateDocMeta } from "./edge-gate.js";

const HOME = process.env.HOME ?? "";
const DEFAULT_OMNESIS_DB = `${HOME}/.config/omnesis/omnesis.db`;

interface OmnesisDocRow {
  id: string;
  content_hash: string | null;
  extracted_content_hash: string | null;
  doc_type: string;
  thread_id: string | null;
  people_json: string | null;
}

interface AnnotateDocMeta extends FilterDocMeta {
  senderAddress: string | null;
}

/**
 * Extract the sender's email from a JSON-encoded `metadata.people`
 * array. Returns null when the array is malformed, when there is no
 * sender, or when the sender carries no email.
 */
function extractSender(peopleJson: string | null): string | null {
  if (!peopleJson) return null;
  try {
    const arr = JSON.parse(peopleJson) as Array<{ role?: string; emails?: string[] }>;
    if (!Array.isArray(arr)) return null;
    for (const p of arr) {
      if (p.role === "sender" && Array.isArray(p.emails) && p.emails.length > 0) {
        const addr = p.emails[0];
        if (typeof addr === "string" && addr.length > 0) return addr.toLowerCase();
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function loadDocMeta(
  omnesisDb: Database.Database,
  ids: Iterable<string>,
): Map<string, AnnotateDocMeta> {
  const idList = [...ids];
  const out = new Map<string, AnnotateDocMeta>();
  const chunk = 800;
  for (let i = 0; i < idList.length; i += chunk) {
    const slice = idList.slice(i, i + chunk);
    const placeholders = slice.map(() => "?").join(",");
    const rows = omnesisDb
      .prepare(
        `SELECT id, content_hash, extracted_content_hash,
                json_extract(metadata, '$.documentType') AS doc_type,
                json_extract(metadata, '$.extra.threadId') AS thread_id,
                json_extract(metadata, '$.people')        AS people_json
         FROM documents WHERE id IN (${placeholders})`,
      )
      .all(...slice) as OmnesisDocRow[];
    for (const r of rows) {
      out.set(r.id, {
        contentHash: r.content_hash,
        extractedContentHash: r.extracted_content_hash,
        docType: r.doc_type ?? "document",
        threadId: r.thread_id,
        senderAddress: extractSender(r.people_json),
      });
    }
  }
  return out;
}

interface PairRow {
  doc_a: string;
  doc_b: string;
  algo_version: string;
  jaccard: number;
  intersection_size: number | null;
  pair_unique_df2: number | null;
  pair_unique_df5: number | null;
}

const annotate = defineCommand({
  meta: {
    name: "annotate",
    description:
      "Backfill suppression flags + production gate decision on every recorded pair. Idempotent; re-running re-evaluates from the current omnesis.db state.",
  },
  args: {
    dupesDb: { type: "string", default: defaultDupeDbPath() },
    omnesisDb: { type: "string", default: DEFAULT_OMNESIS_DB },
    algoVersion: {
      type: "string",
      description: "Limit annotation to a single algo_version. Default: all.",
      default: "",
    },
    force: {
      type: "boolean",
      description: "Re-annotate even rows that already have annotated_at set.",
      default: false,
    },
  },
  run({ args }) {
    const store = new DupeStore(args.dupesDb);
    const omnesisDb = new Database(args.omnesisDb, { readonly: true, fileMustExist: true });

    const where: string[] = [];
    const params: unknown[] = [];
    if (args.algoVersion) {
      where.push("algo_version = ?");
      params.push(args.algoVersion);
    }
    if (!args.force) where.push("annotated_at IS NULL");
    const sql = `SELECT doc_a, doc_b, algo_version, jaccard,
                        intersection_size, pair_unique_df2, pair_unique_df5
                 FROM pairs${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;

    const rows = store.db.prepare(sql).all(...params) as PairRow[];
    process.stderr.write(`[annotate] ${rows.length} pairs to evaluate\n`);

    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.doc_a);
      ids.add(r.doc_b);
    }
    const meta = loadDocMeta(omnesisDb, ids);
    process.stderr.write(`[annotate] fetched ${meta.size}/${ids.size} doc metas\n`);

    // Need each doc's shingle count to compute containment for the gate.
    const shingleStmt = store.db.prepare(
      `SELECT document_id, shingle_count FROM document_minhash
       WHERE algo_version = ? AND document_id IN (${[...ids].map(() => "?").join(",")})`,
    );
    const shingleCounts = new Map<string, number>();
    for (const algo of new Set(rows.map((r) => r.algo_version))) {
      const sRows = shingleStmt.all(algo, ...ids) as Array<{
        document_id: string;
        shingle_count: number;
      }>;
      for (const r of sRows) {
        // First-write-wins: shingle_count is algo-stable since the same
        // shingling produces the same count across algo versions.
        if (!shingleCounts.has(r.document_id)) shingleCounts.set(r.document_id, r.shingle_count);
      }
    }

    const update = store.db.prepare(
      `UPDATE pairs
         SET is_exact_dupe = ?, is_same_thread = ?,
             gate_status = ?, gate_family = ?,
             annotated_at = ?
       WHERE doc_a = ? AND doc_b = ? AND algo_version = ?`,
    );
    const now = Math.floor(Date.now() / 1000);

    let exact = 0;
    let thread = 0;
    let gatePass = 0;
    let gateAutomated = 0;
    let gateBelow = 0;
    let missingMeta = 0;

    const tx = store.db.transaction(() => {
      for (const r of rows) {
        const a = meta.get(r.doc_a);
        const b = meta.get(r.doc_b);
        if (!a || !b) {
          missingMeta++;
          continue;
        }

        const ex = isExactDupe(a, b) ? 1 : 0;
        const sm = !ex && isSameThread(a, b) ? 1 : 0;

        // Gate decision (independent of the existing edge-type
        // filters). Production should still suppress when isExactDupe
        // or isSameThread fires — those edges already exist elsewhere
        // in Omnesis — so the gate is only consulted when both are 0.
        const shA = shingleCounts.get(r.doc_a);
        const shB = shingleCounts.get(r.doc_b);
        const inter = r.intersection_size ?? 0;
        const containmentMin =
          shA && shB && Math.min(shA, shB) > 0 ? inter / Math.min(shA, shB) : 0;
        const scores: PairScores = {
          jaccard: r.jaccard,
          pairUniqueDf2: r.pair_unique_df2 ?? 0,
          pairUniqueDf5: r.pair_unique_df5 ?? 0,
          containmentMin,
        };
        const gateA: GateDocMeta = { docType: a.docType, senderAddress: a.senderAddress };
        const gateB: GateDocMeta = { docType: b.docType, senderAddress: b.senderAddress };
        const decision = gatePair(scores, gateA, gateB);

        update.run(ex, sm, decision.status, decision.family, now, r.doc_a, r.doc_b, r.algo_version);

        if (ex) exact++;
        else if (sm) thread++;
        if (decision.status === "pass") gatePass++;
        else if (decision.status === "automated-sender") gateAutomated++;
        else if (decision.status === "below-threshold") gateBelow++;
      }
    });
    tx();

    process.stderr.write(
      `[annotate] edge-filter: ${exact} exact-dupes, ${thread} same-thread\n` +
        `[annotate] production-gate: ${gatePass} pass, ${gateAutomated} automated-sender, ${gateBelow} below-threshold\n` +
        (missingMeta > 0 ? `[annotate] ${missingMeta} skipped (doc not in corpus)\n` : ""),
    );

    omnesisDb.close();
    store.close();
  },
});

const main = defineCommand({
  meta: {
    name: "near-dupes-annotate",
    description: "Annotate recorded pairs with edge-emission suppression flags + production gate.",
  },
  subCommands: { annotate },
});

void runMain(main);
