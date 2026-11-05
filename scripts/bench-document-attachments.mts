// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Benchmark and parity capture for `GET /documents/:id/attachments` on a
 * large, encrypted, invented corpus, with one sibling id-prefix route
 * (`/documents/:id/dates`) for comparison.
 *
 *   npx tsx scripts/bench-document-attachments.mts build   <dir> [documents=208000]
 *   npx tsx scripts/bench-document-attachments.mts measure <dir> [runs=7]
 *   npx tsx scripts/bench-document-attachments.mts capture <dir> <out.json>
 *
 * `build` creates `<dir>/omnesis.db` with the full gateway schema, keyed like a
 * production store, and fills it with invented documents: one large mail-like
 * source whose messages carry attachment children (one parent with hundreds),
 * a file source with external ids holding LIKE metacharacters and case
 * variants, and a two-stream chat source. `measure` opens the store the way
 * the gateway's main thread does (read-only, the default page cache) and
 * times the route through its real mount, recording request latency and the
 * longest event-loop block (`monitorEventLoopDelay`). Each run opens a fresh
 * handle, so its first request pays decryption like a request after the cache
 * has turned over; a second request on the same handle is the warm case.
 * `capture` writes the status and body of every behaviour case, so two
 * checkouts' outputs can be diffed for parity.
 *
 * Copy the script into another checkout to measure that checkout's route: it
 * imports the route code relative to its own location. Never point it at a
 * live config directory; it writes the store it measures.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Hono } from "hono";

import { createDatabase, openReadOnlyDatabase } from "../packages/gateway/src/db.js";
import { mountDocumentRefsRoute } from "../packages/gateway/src/http/routes/documents.js";
import { DocumentService } from "../packages/gateway/src/http/services/DocumentService.js";
import { errorResponse, HttpError } from "../packages/gateway/src/http/errors.js";
import type { Db } from "../packages/gateway/src/data/types.js";
import type { RouteApp } from "../packages/gateway/src/http/routes/types.js";

const [mode, dir, arg] = process.argv.slice(2);
if (!mode || !dir) {
  console.error("usage: bench-document-attachments.mts build|measure|capture <dir> [arg]");
  process.exit(2);
}
const dbPath = join(dir, "omnesis.db");
const keyPath = join(dir, "key.hex");
const casesPath = join(dir, "cases.json");
/** The gateway's default main-thread page cache (`runtime-settings.ts`). */
const READ_CACHE_BYTES = 256 * 1024 * 1024;

// ── deterministic invented content ─────────────────────────────────────────

let seed = 0x5eed1234;
function random(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const WORDS =
  "quarterly budget review marathon entry heart rate trend studio northstar riverside estate stellar sound invoice draft agenda follow up schedule venue catering summary notes travel itinerary garden supplies weekly report checklist renewal reminder".split(
    " ",
  );
function text(minBytes: number, maxBytes: number): string {
  const target = minBytes + Math.floor(random() * (maxBytes - minBytes));
  const out: string[] = [];
  let length = 0;
  while (length < target) {
    const word = WORDS[Math.floor(random() * WORDS.length)]!;
    out.push(word);
    length += word.length + 1;
  }
  return out.join(" ");
}

interface Cases {
  heavyParent: string;
  fortyParent: string;
  smallParent: string;
  noChildren: string;
  metacharParent: string;
  caseParent: string;
  missing: string;
}

function build(documents: number): void {
  mkdirSync(dir!, { recursive: true });
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists; build into an empty directory`);
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"));
  const db = createDatabase(dbPath, { encryptionKey: key });
  const insert = db.prepare(`
    INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content,
      content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let written = 0;
  let clock = Date.parse("2025-01-01T00:00:00Z");
  const add = (
    providerId: string,
    sourceId: string,
    externalId: string,
    streamId: string,
    metadata: Record<string, unknown>,
    content = text(1_000, 6_000),
  ): string => {
    const id = randomUUID();
    clock += 60_000;
    const at = new Date(clock).toISOString();
    insert.run(
      id,
      providerId,
      sourceId,
      externalId,
      streamId,
      text(20, 60),
      content,
      `hash-${written}`,
      JSON.stringify(metadata),
      at,
      at,
      at,
      at,
    );
    written += 1;
    return id;
  };
  const attachment = (index: number) => ({
    documentType: "attachment",
    sourceUrl: `https://mail.example.com/att/${index}`,
    extra: { mimeType: "application/pdf", sizeBytes: 10_000 + index, pages: 1 + (index % 9) },
  });
  const withChildren = (
    providerId: string,
    sourceId: string,
    externalId: string,
    streamId: string,
    count: number,
  ): string => {
    const id = add(providerId, sourceId, externalId, streamId, { documentType: "email" });
    for (let i = 0; i < count; i++) {
      add(
        providerId,
        sourceId,
        `${externalId}/att/${i}`,
        streamId,
        attachment(i),
        text(500, 3_000),
      );
    }
    return id;
  };

  const mailShare = Math.round(documents * 0.6);
  const fileShare = Math.round(documents * 0.18);
  const tx = (fn: () => void) => db.transaction(fn)();
  const cases: Partial<Cases> = {};
  tx(() => {
    cases.heavyParent = withChildren("google", "gmail-bench", "m-heavy", "", 300);
    cases.fortyParent = withChildren("google", "gmail-bench", "m-forty", "", 40);
    cases.smallParent = withChildren("google", "gmail-bench", "m-small", "", 2);
  });
  let message = 0;
  while (written < mailShare) {
    tx(() => {
      for (let i = 0; i < 2_000 && written < mailShare; i++, message++) {
        const roll = random();
        const children = roll < 0.12 ? 1 + Math.floor(random() * 3) : 0;
        withChildren("google", "gmail-bench", `m-${message}`, "", children);
      }
    });
    process.stdout.write(`\r${written} documents`);
  }
  tx(() => {
    cases.noChildren = add("files", "drive-bench", "folder/plain-note", "", {
      documentType: "note",
    });
    // A LIKE pattern built from this external id without escaping treats `_`
    // and `%` as wildcards, so the second parent's child also matches it.
    cases.metacharParent = withChildren(
      "files",
      "drive-bench",
      "https://example.com/a_b%20c",
      "",
      2,
    );
    withChildren("files", "drive-bench", "https://example.com/aXb%20cd", "", 1);
    // Case-insensitive LIKE also matches a sibling differing only in case.
    cases.caseParent = withChildren("files", "drive-bench", "Folder/Report", "", 1);
    withChildren("files", "drive-bench", "folder/report", "", 1);
  });
  let file = 0;
  while (written < mailShare + fileShare) {
    tx(() => {
      for (let i = 0; i < 2_000 && written < mailShare + fileShare; i++, file++) {
        add("files", "drive-bench", `folder/${file}.txt`, "", { documentType: "file" });
      }
    });
    process.stdout.write(`\r${written} documents`);
  }
  const streams = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2"];
  let chat = 0;
  while (written < documents) {
    tx(() => {
      for (let i = 0; i < 2_000 && written < documents; i++, chat++) {
        add("chat", "chat-bench", `room-${chat % 50}/msg-${chat}`, streams[chat % 2]!, {
          documentType: "message",
        });
      }
    });
    process.stdout.write(`\r${written} documents`);
  }
  cases.missing = randomUUID();
  writeFileSync(casesPath, JSON.stringify(cases, null, 2));
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  console.log(`\nbuilt ${written} documents in ${dbPath}`);
}

// ── the route, mounted the way the server mounts it ────────────────────────

function openApp(): { db: Db; app: Hono } {
  const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
  const db = openReadOnlyDatabase(dbPath, { encryptionKey: key, cacheSizeBytes: READ_CACHE_BYTES });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set(
      "auth" as never,
      {
        authMethod: "bearer",
        deviceId: null,
        tokenId: null,
        scopes: ["read"],
      } as never,
    );
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  const documentService = new DocumentService({
    db,
    // The routes measured here only read; the write-side collaborators are
    // never reached.
    writeGate: {} as never,
    events: {} as never,
    sourceDataRemoval: {} as never,
  });
  mountDocumentRefsRoute(app as unknown as RouteApp, { db, documentService });
  return { db, app };
}

function loadCases(): Cases {
  return JSON.parse(readFileSync(casesPath, "utf8")) as Cases;
}

function behaviourCases(db: Db, c: Cases): Array<[string, string]> {
  // An ambiguous prefix: the first two characters of the heavy parent's id
  // match about 1/256 of the corpus.
  const ambiguous = c.heavyParent.slice(0, 2);
  const unique = c.heavyParent.slice(0, 13);
  const firstId = db.prepare<[], { id: string }>("SELECT id FROM documents LIMIT 1").get()!.id;
  return [
    ["full id, many attachments", c.heavyParent],
    ["full id, forty attachments", c.fortyParent],
    ["full id, two attachments", c.smallParent],
    ["full id, no attachments", c.noChildren],
    ["unique prefix", unique],
    ["ambiguous prefix", ambiguous],
    ["one-character prefix", firstId.slice(0, 1)],
    ["missing id", c.missing],
    ["uppercase full id", c.heavyParent.toUpperCase()],
    ["uppercase unique prefix", unique.toUpperCase()],
    ["parent external id with LIKE metacharacters", c.metacharParent],
    ["parent external id with a case-variant sibling", c.caseParent],
    ["underscore wildcard prefix", `${c.heavyParent.slice(0, 7)}_${c.heavyParent.slice(8, 13)}`],
    ["percent wildcard prefix", `${c.heavyParent.slice(0, 4)}%${c.heavyParent.slice(20, 24)}`],
    ["lone percent", "%"],
    ["lone underscore", "_"],
    ["malformed id", "not-a-document-id"],
    ["non-ascii id", "é"],
  ];
}

async function capture(out: string): Promise<void> {
  const { db, app } = openApp();
  const cases = loadCases();
  const results: Array<{ name: string; status: number; body: string }> = [];
  for (const [name, id] of behaviourCases(db, cases)) {
    const res = await app.request(`/documents/${encodeURIComponent(id)}/attachments`);
    results.push({ name, status: res.status, body: await res.text() });
  }
  writeFileSync(out, JSON.stringify(results, null, 2));
  for (const r of results) console.log(`${r.status}  ${r.name}  (${r.body.length} bytes)`);
  db.close();
}

async function timed(
  app: Hono,
  path: string,
): Promise<{ ms: number; blockedMs: number; status: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const started = performance.now();
  const res = await app.request(path);
  await res.arrayBuffer();
  const ms = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 5));
  histogram.disable();
  return { ms, blockedMs: histogram.max / 1e6, status: res.status };
}

function summary(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return `median ${median.toFixed(1)} ms, worst ${sorted.at(-1)!.toFixed(1)} ms`;
}

async function measure(runs: number): Promise<void> {
  const cases = loadCases();
  const attachments = (id: string) => `/documents/${encodeURIComponent(id)}/attachments`;
  const probes: Array<[string, (c: Cases) => string]> = [
    ["attachments, full id, 300 attachments", (c) => attachments(c.heavyParent)],
    ["attachments, full id, 2 attachments", (c) => attachments(c.smallParent)],
    ["attachments, unique 13-character prefix", (c) => attachments(c.heavyParent.slice(0, 13))],
    ["attachments, missing id", (c) => attachments(c.missing)],
    // A sibling route whose id lookup reads only the primary key's index.
    ["dates, full id", (c) => `/documents/${c.heavyParent}/dates`],
  ];
  const rssBefore = process.memoryUsage().rss;
  for (const [name, pick] of probes) {
    const cold = { ms: [] as number[], blocked: [] as number[] };
    const warm = { ms: [] as number[], blocked: [] as number[] };
    for (let run = 0; run < runs; run++) {
      const { db, app } = openApp();
      const first = await timed(app, pick(cases));
      const second = await timed(app, pick(cases));
      cold.ms.push(first.ms);
      cold.blocked.push(first.blockedMs);
      warm.ms.push(second.ms);
      warm.blocked.push(second.blockedMs);
      db.close();
    }
    console.log(`${name}`);
    console.log(`  fresh handle  latency ${summary(cold.ms)}; blocked ${summary(cold.blocked)}`);
    console.log(`  warm handle   latency ${summary(warm.ms)}; blocked ${summary(warm.blocked)}`);
  }
  console.log(
    `rss growth over the run: ${((process.memoryUsage().rss - rssBefore) / 1024 / 1024).toFixed(0)} MiB`,
  );
}

if (mode === "build") build(Number(arg ?? 208_000));
else if (mode === "measure") await measure(Number(arg ?? 7));
else if (mode === "capture") {
  if (!arg) throw new Error("capture needs an output path");
  await capture(arg);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
