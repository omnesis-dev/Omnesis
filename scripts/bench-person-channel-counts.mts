// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Benchmark for the per-person channel counts that `lookup_people` returns,
 * on a large, encrypted, invented corpus.
 *
 *   npx tsx scripts/bench-person-channel-counts.mts build   <dir> [documents=200000]
 *   npx tsx scripts/bench-person-channel-counts.mts measure <dir> [runs=5]
 *
 * `build` creates `<dir>/omnesis.db` with the full gateway schema, keyed like
 * a production store, and fills it with invented documents of 2–24 KiB. One
 * person (the owner) is linked to about 70% of them, under two roles for some,
 * through a merged duplicate as well as directly; a second person is linked to
 * about 3.5%, a third to a few dozen. It drops the id/type index first, then
 * times creating it, which is what the migration costs at boot.
 *
 * `measure` opens the store the way an io worker does (read-only, its 64 MiB
 * page cache) and times two queries per person: the plain join that reads
 * each linked document's row, and `PERSON_CHANNEL_COUNTS_SQL`. Each run opens
 * a fresh handle, so the first query pays decryption as it does after the
 * cache has turned over; a second call on the same handle is the warm case. It checks both
 * queries return the same rows and prints the plan each one used.
 *
 * Never point it at a live config directory; it writes the store it measures.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createDatabase, openReadOnlyDatabase } from "../packages/gateway/src/db.js";
import { DOCUMENTS_ID_TYPE_INDEX } from "../packages/gateway/src/data/migration-216-documents-id-type-index.js";
import { PERSON_CHANNEL_COUNTS_SQL } from "../packages/gateway/src/data/repositories/PersonRepository.js";
import type { Db } from "../packages/gateway/src/data/types.js";

const [mode, dir, arg] = process.argv.slice(2);
if ((mode !== "build" && mode !== "measure") || !dir) {
  console.error("usage: bench-person-channel-counts.mts build|measure <dir> [arg]");
  process.exit(2);
}
const dbPath = join(dir, "omnesis.db");
const keyPath = join(dir, "key.hex");
/** The io worker's read-handle page cache (`runtime-settings.ts`). */
const IO_READ_CACHE_BYTES = 64 * 1024 * 1024;

/** The row-read join: every linked document's row is read for its type. */
const ROW_READ_SQL = `WITH RECURSIVE merge_class(id) AS (
     SELECT id FROM people WHERE id = ?
     UNION
     SELECT p.id FROM people p JOIN merge_class mc ON p.merged_into = mc.id
   )
   SELECT json_extract(d.metadata, '$.documentType') AS document_type,
          COUNT(DISTINCT d.id) AS n
   FROM document_people dp
   JOIN documents d ON d.id = dp.document_id
   WHERE dp.person_id IN (SELECT id FROM merge_class)
   GROUP BY document_type`;

const PEOPLE = [
  { id: "owner", share: 0.7 },
  { id: "frequent", share: 0.035 },
  { id: "occasional", share: 0.0002 },
];

let seed = 0x5eed4321;
function random(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const WORDS =
  "budget review quarterly marathon entry form heart rate trend venue schedule invoice notes draft".split(
    " ",
  );
function body(bytes: number): string {
  const out: string[] = [];
  let size = 0;
  while (size < bytes) {
    const word = WORDS[Math.floor(random() * WORDS.length)]!;
    out.push(word);
    size += word.length + 1;
  }
  return out.join(" ");
}

function build(): void {
  const documents = Number(arg ?? 200_000);
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists; use a fresh directory`);
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"));
  const db = createDatabase(dbPath, { encryptionKey: key });
  const now = "2026-01-01T00:00:00Z";
  const person = db.prepare(
    `INSERT INTO people (id, canonical_name, merged_into, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?)`,
  );
  person.run("owner", "Maya Reeves", null, 1, now, now, now, now);
  person.run("owner-dup", "Maya R.", "owner", 0, now, now, now, now);
  person.run("frequent", "Jamie Lopez", null, 0, now, now, now, now);
  person.run("occasional", "David Lin", null, 0, now, now, now, now);
  const doc = db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata,
                            source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'bench', 'bench', ?, 'Example', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const link = db.prepare(
    "INSERT OR IGNORE INTO document_people (document_id, person_id, role, source_id) VALUES (?, ?, ?, 'bench')",
  );
  const types = ["email", "email", "conversation", "conversation", "event", "file", "note"];
  const batch = 5_000;
  for (let start = 0; start < documents; start += batch) {
    db.transaction(() => {
      for (let i = start; i < Math.min(documents, start + batch); i++) {
        const id = `doc-${i}`;
        const type = types[Math.floor(random() * types.length)]!;
        doc.run(
          id,
          id,
          body(2048 + Math.floor(random() * 22 * 1024)),
          `h${i}`,
          JSON.stringify({ documentType: type }),
          now,
          now,
          now,
          now,
        );
        for (const p of PEOPLE) {
          if (random() >= p.share) continue;
          const holder = p.id === "owner" && random() < 0.1 ? "owner-dup" : p.id;
          link.run(id, holder, "participant");
          if (random() < 0.2) link.run(id, holder, "sender");
        }
      }
    })();
  }
  db.exec(`DROP INDEX IF EXISTS ${DOCUMENTS_ID_TYPE_INDEX}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const t = performance.now();
  db.exec(
    `CREATE INDEX ${DOCUMENTS_ID_TYPE_INDEX} ON documents(id, json_extract(metadata, '$.documentType'))`,
  );
  const indexMs = performance.now() - t;
  const pages = (name: string) =>
    (
      db.prepare("SELECT COUNT(*) AS n FROM dbstat WHERE name = ?").get(name) as
        { n: number } | undefined
    )?.n;
  let indexPages: number | undefined;
  try {
    indexPages = pages(DOCUMENTS_ID_TYPE_INDEX);
  } catch {
    indexPages = undefined;
  }
  db.close();
  console.log(JSON.stringify({ documents, indexBuildMs: Math.round(indexMs), indexPages }));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function measure(): void {
  const runs = Number(arg ?? 5);
  const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
  const open = (): Db =>
    openReadOnlyDatabase(dbPath, { encryptionKey: key, cacheSizeBytes: IO_READ_CACHE_BYTES });
  const probe = open();
  const links = (id: string) =>
    (
      probe
        .prepare(
          `SELECT COUNT(DISTINCT document_id) AS n FROM document_people
           WHERE person_id = ? OR person_id IN (SELECT id FROM people WHERE merged_into = ?)`,
        )
        .get(id, id) as { n: number }
    ).n;
  const plan = (sql: string) =>
    probe
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all("owner")
      .map((row) => (row as { detail: string }).detail)
      .filter((detail) => /\b(SCAN|SEARCH) d\b/.test(detail));
  console.log(
    JSON.stringify({
      plan: { rowRead: plan(ROW_READ_SQL), indexRead: plan(PERSON_CHANNEL_COUNTS_SQL) },
    }),
  );
  for (const person of PEOPLE) {
    const result: Record<string, unknown> = { person: person.id, documents: links(person.id) };
    let expected: string | undefined;
    for (const [label, sql] of [
      ["rowRead", ROW_READ_SQL],
      ["indexRead", PERSON_CHANNEL_COUNTS_SQL],
    ] as const) {
      const cold: number[] = [];
      const warm: number[] = [];
      for (let run = 0; run < runs; run++) {
        const db = open();
        const statement = db.prepare(sql);
        let t = performance.now();
        const rows = statement.all(person.id);
        cold.push(performance.now() - t);
        t = performance.now();
        statement.all(person.id);
        warm.push(performance.now() - t);
        db.close();
        const shape = JSON.stringify(
          (rows as Array<{ document_type: string | null; n: number }>).sort((a, b) =>
            String(a.document_type).localeCompare(String(b.document_type)),
          ),
        );
        if (expected === undefined) expected = shape;
        else if (shape !== expected) throw new Error(`${label} disagrees for ${person.id}`);
      }
      result[label] = {
        coldMedianMs: Math.round(median(cold)),
        coldWorstMs: Math.round(Math.max(...cold)),
        warmMedianMs: Math.round(median(warm)),
      };
    }
    console.log(JSON.stringify(result));
  }
  probe.close();
}

if (mode === "build") build();
else measure();
