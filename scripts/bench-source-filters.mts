// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Benchmark for the source-filter check, which reads each record's own
 * version and metadata and keeps no table of which record has which value.
 *
 *   npx tsx scripts/bench-source-filters.mts [documents=1000000] [contentBytes=900] [scans=3] [points=200]
 *
 * It builds a throwaway store under the system temp directory, keyed like a
 * production one, holding one invented account of `documents` records:
 *
 * - half at source version 0 (no label or folder detail), half at version 2;
 * - 200 labels, one to three on each new record;
 * - a folder tree of 50,000 nodes, eight levels deep, one folder per new record;
 * - 2,000 chats of about eight members each, one chat per record;
 * - a sender and one to four recipients on every record, from 5,000 invented
 *   addresses, in the older stored form on the old half;
 * - one record in fifty an attachment of the record before it.
 *
 * Every read is timed on a read-only handle opened the way the gateway opens
 * its readers. `scans` is how often each whole-account read is repeated and
 * `points` how often each bounded read is. The table says, for each
 * operation, where it would run in the gateway.
 *
 * The store is deleted on exit. Never point this at a live config directory:
 * it creates and removes the files it measures.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  decideDocumentAccess,
  documentAccessInclusionSql,
  filterReadableDocumentIds,
  type DocumentAccessGrant,
} from "../packages/gateway/src/access/filter-decision.js";
import { readFilterOptions } from "../packages/gateway/src/access/filter-editor-reads.js";
import { filterFieldsFor } from "../packages/gateway/src/access/filter-fields.js";
import { registerFilterSqlFunctions } from "../packages/gateway/src/access/filter-people.js";
import { countUnmatchedRecords } from "../packages/gateway/src/access/filter-readiness.js";
import {
  INDEX_FILTER_TABLES,
  compileSourceFilter,
  forFewRecords,
  sourceFilterInclusionSql,
} from "../packages/gateway/src/access/filter-sql.js";
import { upsertSourceDocumentProfiles } from "../packages/gateway/src/data/repositories/SourceDocumentProfileRepository.js";
import {
  stageFilterListPart,
  type FilterListStagedRow,
} from "../packages/gateway/src/data/repositories/SourceFilterListRepository.js";
import { createDatabase, openReadOnlyDatabase } from "../packages/gateway/src/db.js";
import { createIndexDatabase } from "../packages/gateway/src/indexer/db.js";
import {
  buildFilterCopyBatch,
  refreshFilterListCopy,
  writeFilterCopyBatch,
} from "../packages/gateway/src/indexer/filter-copy.js";
import type { FilterRef, SourceFilter } from "../packages/types/src/index.js";

const [documentsArg, contentArg, scansArg, pointsArg] = process.argv.slice(2);
const TOTAL = Number(documentsArg ?? 1_000_000);
const CONTENT_BYTES = Number(contentArg ?? 900);
const SCANS = Number(scansArg ?? 3);
const POINTS = Number(pointsArg ?? 200);
/** The gateway's default read-handle page cache (`runtime-settings.ts`). */
const READ_CACHE_BYTES = 256 * 1024 * 1024;
const SOURCE = "bench-mail:reader";
const LABELS = 200;
const FOLDERS = 50_000;
const FOLDER_FANOUT = 4;
const CHATS = 2_000;
const ADDRESSES = 5_000;

const WORDS =
  "quarterly budget review marathon entry heart rate trend studio northstar riverside estate stellar sound invoice draft agenda follow up schedule venue catering summary notes travel itinerary garden supplies weekly report checklist renewal reminder".split(
    " ",
  );

function random(seed: number): () => number {
  let state = (seed + 1) * 2654435761;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

const address = (n: number): string => `person${n % ADDRESSES}@mail${n % 40}.example.org`;
const phone = (n: number): string => `+1555010${String(n % 10_000).padStart(4, "0")}`;
const folderParent = (n: number): number | null =>
  n === 0 ? null : Math.floor((n - 1) / FOLDER_FANOUT);

function profile(membersOf: boolean): unknown {
  const noun = (one: string) => ({ one, many: `${one}s` });
  return {
    documentTypes: ["message", "attachment"],
    personRoles: ["sender", "recipient"],
    metadataFields: [
      {
        path: "extra.labelIds",
        type: "string-array",
        description: "Label ids.",
        filter: {
          capability: "membership",
          minVersion: 2,
          scope: "global",
          noun: noun("label"),
          picker: "search",
        },
      },
      {
        path: "extra.folderIds",
        type: "string-array",
        description: "Folder ids.",
        filter: {
          capability: "tree",
          minVersion: 2,
          scope: "global",
          noun: noun("folder"),
          picker: "tree",
          inside: noun("folder"),
        },
      },
      {
        path: "extra.chatId",
        type: "string",
        description: "Chat id.",
        filter: {
          capability: "membership",
          minVersion: 0,
          scope: "global",
          noun: noun("chat"),
          picker: "search",
          listsMembers: true,
        },
      },
    ],
    personFilter: {
      minVersion: 0,
      roles: ["sender", "recipient"],
      identifiers: ["email", "phone", "domain"],
      maxPeople: 1000,
      ...(membersOf ? { membersOf: "extra.chatId" } : {}),
    },
  };
}

function metadataAt(index: number): string {
  const next = random(index);
  const old = index % 2 === 0;
  const recipients = 1 + (next() % 4);
  const people: unknown[] = [];
  for (let n = 0; n <= recipients; n++) {
    const who = next();
    const role = n === 0 ? "sender" : "recipient";
    const name = `${WORDS[who % WORDS.length]} ${WORDS[(who >>> 8) % WORDS.length]}`;
    people.push(
      old
        ? { role, name, emails: [address(who)] }
        : { role, name, identifiers: [{ kind: "email", value: address(who) }] },
    );
  }
  const extra: Record<string, unknown> = {
    threadId: `thread-${next() % 200_000}`,
    chatId: `chat-${next() % CHATS}`,
  };
  if (!old) {
    const labels = new Set<string>();
    for (let n = 1 + (next() % 3); n > 0; n--) labels.add(`label-${next() % LABELS}`);
    extra.labelIds = [...labels];
    extra.folderIds = [`folder-${next() % FOLDERS}`];
  }
  if (index % 50 === 49) {
    return JSON.stringify({
      documentType: "attachment",
      people,
      extra: {
        parentExternalId: `message-${index - 1}`,
        originalFilename: "notes.pdf",
        mimeType: "application/pdf",
      },
    });
  }
  return JSON.stringify({
    documentType: "message",
    sourceUrl: `https://mail.example.org/m/${index}`,
    people,
    extra,
  });
}

function contentAt(index: number): string {
  const next = random(index ^ 0x5bd1e995);
  const words: string[] = [];
  let length = 0;
  while (length < CONTENT_BYTES) {
    const word = WORDS[next() % WORDS.length]!;
    words.push(word);
    length += word.length + 1;
  }
  return words.join(" ");
}

function publishList(
  db: ReturnType<typeof createDatabase>,
  field: string,
  rows: FilterListStagedRow[],
): void {
  const digest = randomBytes(32).toString("hex");
  const key = { sourceId: SOURCE, field, deviceId: "" };
  for (let offset = 0, part = 0; offset < rows.length || part === 0; offset += 20_000, part++) {
    const final = offset + 20_000 >= rows.length;
    const result = stageFilterListPart(db, {
      key,
      digest,
      part,
      final,
      rows: rows.slice(offset, offset + 20_000),
      now: Date.now(),
    });
    if (result.kind !== "done") throw new Error("The list page was not applied in one call.");
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function ms(value: number): string {
  return value >= 1000
    ? `${(value / 1000).toFixed(2)} s`
    : `${value.toFixed(value < 10 ? 2 : 1)} ms`;
}

function time(runs: number, run: (index: number) => unknown): number[] {
  const samples: number[] = [];
  for (let index = 0; index < runs; index++) {
    const start = performance.now();
    run(index);
    samples.push(performance.now() - start);
  }
  return samples.sort((a, b) => a - b);
}

const dir = mkdtempSync(join(tmpdir(), "omnesis-bench-source-filters-"));
const dbPath = join(dir, "omnesis.db");
const indexPath = join(dir, "index.db");
const table: Array<[operation: string, where: string, result: string]> = [];
const record = (operation: string, where: string, samples: number[], note = ""): void => {
  table.push([
    operation,
    where,
    `p50 ${ms(percentile(samples, 50))}, p95 ${ms(percentile(samples, 95))}${note ? ` (${note})` : ""}`,
  ]);
  process.stderr.write(`  ${operation}: ${table[table.length - 1]![2]}\n`);
};

try {
  const key = randomBytes(32);
  const db = createDatabase(dbPath, { encryptionKey: key });
  db.pragma("synchronous = OFF");

  // ── build ────────────────────────────────────────────────────────────────
  const buildStart = performance.now();
  const insert = db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content,
       content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_version)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const id = (index: number): string => `doc-${String(index).padStart(8, "0")}`;
  for (let from = 0; from < TOTAL; from += 10_000) {
    db.transaction(() => {
      for (let index = from; index < Math.min(from + 10_000, TOTAL); index++) {
        const at = new Date(Date.parse("2020-01-01T00:00:00Z") + index * 60_000).toISOString();
        insert.run(
          id(index),
          SOURCE,
          SOURCE,
          index % 50 === 49 ? `message-${index - 1}/att/1` : `message-${index}`,
          `message ${index}`,
          contentAt(index),
          `hash-${index}`,
          metadataAt(index),
          at,
          at,
          at,
          at,
          index % 2 === 0 ? 0 : 2,
        );
      }
    })();
  }
  upsertSourceDocumentProfiles(
    db,
    [{ sourceType: "bench-mail", outputRevision: 2, profile: profile(false) as never }],
    Date.now(),
  );
  publishList(
    db,
    "extra.labelIds",
    Array.from({ length: LABELS }, (_unused, n): FilterListStagedRow => [
      "item",
      `label-${n}`,
      null,
      `Label ${n}`,
    ]),
  );
  publishList(
    db,
    "extra.folderIds",
    Array.from({ length: FOLDERS }, (_unused, n): FilterListStagedRow => {
      const parent = folderParent(n);
      return ["item", `folder-${n}`, parent === null ? null : `folder-${parent}`, `Folder ${n}`];
    }),
  );
  const chatRows: FilterListStagedRow[] = [];
  for (let n = 0; n < CHATS; n++) {
    chatRows.push(["item", `chat-${n}`, null, `Chat ${n}`]);
    const next = random(n ^ 0x9e3779b9);
    for (let member = 4 + (next() % 9); member > 0; member--) {
      chatRows.push(["member", `chat-${n}`, "phone", phone(next())]);
    }
    chatRows.push(["member", `chat-${n}`, "email", address(next())]);
  }
  publishList(db, "extra.chatId", chatRows);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("ANALYZE");
  const buildMs = performance.now() - buildStart;
  process.stderr.write(`built ${TOTAL} records in ${ms(buildMs)}\n`);

  // ── filters ──────────────────────────────────────────────────────────────
  const label = (n: number): FilterRef => ({
    capability: "membership",
    field: "extra.labelIds",
    id: `label-${n}`,
  });
  const folder = (n: number): FilterRef => ({
    capability: "tree",
    field: "extra.folderIds",
    id: `folder-${n}`,
  });
  const person = (...ns: number[]): FilterRef => ({
    capability: "person",
    label: "Invented person",
    identifiers: ns.flatMap((n) => [
      { type: "email" as const, value: address(n) },
      { type: "phone" as const, value: phone(n) },
    ]),
  });
  const filter = (action: "share" | "hide", match: FilterRef[]): SourceFilter => ({
    sourceId: SOURCE,
    audience: { accessLevel: "bench", capability: "direct" },
    rules: [{ match, action }],
    otherwise: action === "share" ? "hide" : "share",
  });
  const grant = (filters: SourceFilter[]): DocumentAccessGrant => ({
    capabilityGranted: true,
    permittedSourceIds: null,
    filters,
  });
  const scenarios: Array<[string, FilterRef[]]> = [
    ["membership, 3 labels", [label(1), label(2), label(3)]],
    // folder-3 holds a quarter of the tree: about 12,500 folders beneath it.
    ["tree, a folder holding a quarter of the tree", [folder(3)]],
    ["tree, a leaf folder", [folder(FOLDERS - 1)]],
    ["person, 3 people on the record", [person(1), person(2), person(3)]],
  ];

  const reader = openReadOnlyDatabase(dbPath, {
    encryptionKey: key,
    cacheSizeBytes: READ_CACHE_BYTES,
  });
  registerFilterSqlFunctions(reader);
  const count = (access: DocumentAccessGrant): number => {
    const inclusion = documentAccessInclusionSql(reader, access, "d.id", "d.source_id", {
      row: "d",
    });
    return reader
      .prepare<unknown[], { n: number }>(
        `SELECT count(*) AS n FROM documents d WHERE d.source_id = ? AND ${inclusion.sql}`,
      )
      .get(SOURCE, ...inclusion.params)!.n;
  };
  const newest = (access: DocumentAccessGrant): number => {
    const inclusion = documentAccessInclusionSql(reader, access, "d.id", "d.source_id", {
      row: "d",
    });
    return reader
      .prepare<unknown[], { id: string }>(
        `SELECT d.id FROM documents d WHERE d.source_id = ? AND ${inclusion.sql}
          ORDER BY d.source_created_at DESC LIMIT 20`,
      )
      .all(SOURCE, ...inclusion.params).length;
  };
  const pick = random(7);
  const someIds = (n: number): string[] => Array.from({ length: n }, () => id(pick() % TOTAL));

  const measure = (membersOf: boolean): void => {
    const suffix = membersOf ? ", people also from chat members" : "";
    const cases = membersOf ? scenarios.slice(3) : scenarios;
    for (const [name, match] of cases) {
      for (const action of ["share", "hide"] as const) {
        const access = grant([filter(action, match)]);
        const kind = action === "share" ? "share-only" : "hide";
        let readable = 0;
        record(
          `count readable: ${kind}, ${name}${suffix}`,
          "reader",
          time(SCANS, () => {
            readable = count(access);
          }),
          `${readable} readable`,
        );
        record(
          `20 newest readable: ${kind}, ${name}${suffix}`,
          "reader",
          time(Math.min(POINTS, 20), () => newest(access)),
        );
        record(
          `one document decided: ${kind}, ${name}${suffix}`,
          "reader, or the request thread for one fetch",
          time(POINTS, () => decideDocumentAccess(reader, access, id(pick() % TOTAL))),
        );
        for (const candidates of [20, 200]) {
          record(
            `re-check of ${candidates} result ids: ${kind}, ${name}${suffix}`,
            "search worker's corpus reader",
            time(Math.min(POINTS, 50), () =>
              filterReadableDocumentIds(reader, access, someIds(candidates)),
            ),
          );
        }
      }
    }
  };
  measure(false);

  // ── the editor ───────────────────────────────────────────────────────────
  db.prepare(
    "INSERT INTO devices (id, name, kind, paired_at) VALUES ('bench-device', 'Bench device', 'collector', 1)",
  ).run();
  db.prepare(
    `INSERT INTO sources (id, type, account_id, device_id, created_at, updated_at)
     VALUES (?, 'bench-mail', 'reader', 'bench-device', 1, 1)`,
  ).run(SOURCE);
  db.pragma("wal_checkpoint(TRUNCATE)");
  const options = (request: { field: string; parentId?: string }): number => {
    const result = readFilterOptions(reader, { sourceId: SOURCE, ...request });
    if (!result.ok) throw new Error(result.error);
    return result.value.items.length;
  };
  let offered = 0;
  record(
    "editor: one page of a label list with the count of each",
    "reader",
    time(SCANS, () => {
      offered = options({ field: "extra.labelIds" });
    }),
    `${offered} entries`,
  );
  record(
    "editor: one tree level with the count of each",
    "reader",
    time(SCANS, () => {
      offered = options({ field: "extra.folderIds", parentId: "folder-0" });
    }),
    `${offered} entries`,
  );
  for (const field of ["extra.labelIds", "extra.folderIds", "$people"]) {
    let unmatched: number | null = 0;
    record(
      `records that cannot be placed for ${field}`,
      "reader",
      time(SCANS, () => {
        unmatched = countUnmatchedRecords(reader, SOURCE, field);
      }),
      `${unmatched} records`,
    );
  }

  // ── people that also come from a chat's members ──────────────────────────
  upsertSourceDocumentProfiles(
    db,
    [{ sourceType: "bench-mail", outputRevision: 2, profile: profile(true) as never }],
    Date.now(),
  );
  db.pragma("wal_checkpoint(TRUNCATE)");
  measure(true);

  // ── the copy in the search index ─────────────────────────────────────────
  const indexDb = createIndexDatabase(indexPath, { encryptionKey: key });
  registerFilterSqlFunctions(indexDb);
  const copyStart = performance.now();
  refreshFilterListCopy({ corpusDb: reader, indexDb });
  const declarations = new Map();
  for (let from = 0; from < TOTAL; from += 500) {
    const ids: string[] = [];
    for (let index = from; index < Math.min(from + 500, TOTAL); index++) ids.push(id(index));
    writeFilterCopyBatch(indexDb, buildFilterCopyBatch(reader, ids, declarations));
  }
  const copyMs = performance.now() - copyStart;
  table.push([
    "index copy: write the row of every record",
    "indexer",
    `${ms(copyMs)} in all, ${ms((copyMs / TOTAL) * 500)} per 500 records`,
  ]);
  indexDb.pragma("wal_checkpoint(TRUNCATE)");
  indexDb.exec("ANALYZE");
  const fields = filterFieldsFor(reader, "bench-mail");
  for (const [name, match] of [scenarios[0]!, scenarios[1]!, scenarios[3]!]) {
    for (const action of ["share", "hide"] as const) {
      const compiled = compileSourceFilter(filter(action, match), fields);
      const inclusion = sourceFilterInclusionSql([compiled], "c.document_id", "c.source_id", {
        map: INDEX_FILTER_TABLES,
      });
      const kind = action === "share" ? "share-only" : "hide";
      let readable = 0;
      record(
        `index copy, count readable: ${kind}, ${name}`,
        "search worker",
        time(SCANS, () => {
          readable = indexDb
            .prepare<unknown[], { n: number }>(
              `SELECT count(*) AS n FROM index_filter_documents c WHERE c.source_id = ? AND ${inclusion.sql}`,
            )
            .get(SOURCE, ...inclusion.params)!.n;
        }),
        `${readable} readable`,
      );
      const few = sourceFilterInclusionSql(
        [forFewRecords(compiled)],
        "c.document_id",
        "c.source_id",
        { map: INDEX_FILTER_TABLES },
      );
      const byId = indexDb.prepare<unknown[], { n: number }>(
        `SELECT count(*) AS n FROM index_filter_documents c
          WHERE c.document_id IN (SELECT value FROM json_each(?)) AND ${few.sql}`,
      );
      record(
        `index copy, 200 candidates checked: ${kind}, ${name}`,
        "search worker",
        time(Math.min(POINTS, 50), () => byId.get(JSON.stringify(someIds(200)), ...few.params)),
      );
    }
  }
  indexDb.close();
  reader.close();
  db.close();

  const sizeMb = (path: string): string => `${(statSync(path).size / 1024 / 1024).toFixed(0)} MiB`;
  process.stdout.write(
    `\n${TOTAL} records (${CONTENT_BYTES} bytes of text each), corpus ${sizeMb(dbPath)}, index copy ${sizeMb(indexPath)}, built in ${ms(buildMs)}\n\n`,
  );
  process.stdout.write("| Operation | Runs on | Time |\n|---|---|---|\n");
  for (const [operation, where, result] of table) {
    process.stdout.write(`| ${operation} | ${where} | ${result} |\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
