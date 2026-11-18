// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Benchmark for the People → Rules page (`GET /people/merge-rule-groups`,
 * `PersonService.listMergeRuleGroups`) on a large, encrypted, invented store.
 *
 *   npx tsx scripts/bench-merge-rule-groups.mts build   <dir> [people=60000] [rules=3000] [documents=60000]
 *   npx tsx scripts/bench-merge-rule-groups.mts measure <dir> [runs=7]
 *
 * `build` creates `<dir>/omnesis.db` with the full gateway schema, keyed like a
 * production store, and fills it with invented people (a name and an email
 * each, a phone for one in three), merge rules between them (user and system,
 * single and cluster merges sharing a timestamp, winners named by email,
 * phone or name), the losers' `merged_into` as the rule evaluator leaves it,
 * and documents mentioning the people with a long tail: a few people are on
 * thousands of documents.
 *
 * `measure` loads the page the way the portal does, through a `PersonService`
 * wired to a real io worker, while a 1 ms timer runs on the main thread. Each
 * run loads the first page, the second page through its cursor, a `kind`
 * filter and a `q` filter. It reports, per request, how long the caller waited
 * and the longest gap between timer ticks: the time the main thread was
 * blocked. Where the read runs on the main handle the two are the same.
 *
 * The same script measures either checkout: it awaits whatever
 * `listMergeRuleGroups` returns, so a synchronous read is timed as one block.
 *
 * Never point it at a live config directory; it writes the store it measures.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createDatabase, openReadOnlyDatabase } from "../packages/gateway/src/db.js";
import { Scheduler } from "../packages/gateway/src/scheduler/scheduler.js";
import { IoTaskRunner } from "../packages/gateway/src/scheduler/runners/io.js";
import { ioGateFromScheduler } from "../packages/gateway/src/scheduler/io-ops.js";
import { PersonService } from "../packages/gateway/src/http/services/PersonService.js";
import type { WriteGate } from "../packages/gateway/src/write-gate.js";

const [mode, dir, ...rest] = process.argv.slice(2);
if ((mode !== "build" && mode !== "measure") || !dir) {
  console.error("usage: bench-merge-rule-groups.mts build|measure <dir> [args]");
  process.exit(2);
}
const dbPath = join(dir, "omnesis.db");
const keyPath = join(dir, "key.hex");
/** The main read handle's and an io worker's page caches (`runtime-settings.ts`). */
const MAIN_READ_CACHE_BYTES = 256 * 1024 * 1024;
const IO_READ_CACHE_BYTES = 64 * 1024 * 1024;

let seed = 0x5eed_c0de;
function random(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

const FIRST =
  "Maya Jamie David Sarah Noah Lena Omar Priya Tomas Iris Felix Nora Ravi Elsa Hugo".split(" ");
const LAST =
  "Reeves Lopez Lin Mendez Okafor Brandt Haddad Sato Novak Quinn Marsh Ellery Voss".split(" ");
const SOURCES = Array.from({ length: 8 }, (_, i) => `bench-source-${i}`);
const WORDS = "budget review quarterly marathon entry form heart rate venue schedule invoice".split(
  " ",
);

function body(bytes: number): string {
  const out: string[] = [];
  let size = 0;
  while (size < bytes) {
    const word = pick(WORDS);
    out.push(word);
    size += word.length + 1;
  }
  return out.join(" ");
}

function iso(dayOffset: number, second = 0): string {
  return new Date(Date.UTC(2025, 0, 1) + dayOffset * 86_400_000 + second * 1000).toISOString();
}

function build(): void {
  const people = Number(rest[0] ?? 60_000);
  const rules = Number(rest[1] ?? 3_000);
  const documents = Number(rest[2] ?? 60_000);
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists; use a fresh directory`);
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"));
  const db = createDatabase(dbPath, { encryptionKey: key });

  type Person = { id: string; name: string; email: string; phone: string | null };
  const roster: Person[] = [];
  const insertPerson = db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'bench', 0, ?, ?, ?, ?)`,
  );
  const insertAlias = db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < people; i++) {
      const first = pick(FIRST);
      const last = pick(LAST);
      const person: Person = {
        id: `person-${i}`,
        name: `${first} ${last} ${i}`,
        email: `${first}.${last}.${i}@example.com`.toLowerCase(),
        phone: i % 3 === 0 ? `+1555${String(i).padStart(7, "0")}` : null,
      };
      roster.push(person);
      const at = iso(i % 300);
      insertPerson.run(person.id, person.name, at, at, at, at);
      const source = pick(SOURCES);
      insertAlias.run(`alias-${i}-n`, person.id, person.name, "name", source, at);
      insertAlias.run(`alias-${i}-e`, person.id, person.email, "email", source, at);
      if (person.phone)
        insertAlias.run(`alias-${i}-p`, person.id, person.phone, "phone", source, at);
    }
  })();

  const insertRule = db.prepare(
    `INSERT OR IGNORE INTO merge_rules
       (id, kind, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias,
        winner_side, reason, created_at, created_by, active, group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
  );
  const setMerged = db.prepare("UPDATE people SET merged_into = ? WHERE id = ?");
  const side = (person: Person): { type: string; alias: string } => {
    const r = random();
    if (r < 0.25) return { type: "name", alias: person.name.toLowerCase() };
    if (r < 0.35 && person.phone) return { type: "phone", alias: person.phone };
    return { type: "email", alias: person.email };
  };
  let written = 0;
  let cursor = 0;
  db.transaction(() => {
    while (written < rules) {
      // One merge: a winner and one to four losers, a cluster merge sharing a
      // group id and a timestamp when there is more than one.
      const winner = roster[cursor++]!;
      const losers = Array.from(
        { length: 1 + Math.floor(random() ** 3 * 4) },
        () => roster[cursor++]!,
      );
      const kind = random() < 0.7 ? "user" : "system";
      const groupId = losers.length > 1 ? `group-${written}` : null;
      const at = iso(written % 400, written % 7);
      for (const loser of losers) {
        const w = side(winner);
        const l = side(loser);
        // Sides are stored in (type, alias) order; the winner is whichever side it lands on.
        const winnerFirst = `${w.type}\u0000${w.alias}` < `${l.type}\u0000${l.alias}`;
        const [a, b] = winnerFirst ? [w, l] : [l, w];
        insertRule.run(
          `rule-${written}`,
          kind,
          a.type,
          a.alias,
          b.type,
          b.alias,
          winnerFirst ? "a" : "b",
          kind === "user" ? "Same person" : null,
          at,
          groupId,
        );
        setMerged.run(winner.id, loser.id);
        written++;
      }
    }
  })();

  // Documents, each mentioning two to five people; a few people are on most.
  const insertDoc = db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata,
                            source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'bench', ?, ?, 'Example', ?, ?, '{}', ?, ?, ?, ?)`,
  );
  const insertMention = db.prepare(
    `INSERT OR IGNORE INTO document_people (document_id, person_id, role, source_id) VALUES (?, ?, ?, ?)`,
  );
  const heavy = Math.min(cursor, people);
  for (let start = 0; start < documents; start += 2_000) {
    db.transaction(() => {
      for (let i = start; i < Math.min(documents, start + 2_000); i++) {
        const source = pick(SOURCES);
        const at = iso(i % 700);
        insertDoc.run(
          `doc-${i}`,
          source,
          `doc-${i}`,
          body(1024 + Math.floor(random() * 6144)),
          `h${i}`,
          at,
          at,
          at,
          at,
        );
        const mentions = 2 + Math.floor(random() * 4);
        for (let m = 0; m < mentions; m++) {
          // Skewed toward the people the rules touch, with a long tail.
          const index = Math.floor(random() ** 4 * heavy);
          insertMention.run(
            `doc-${i}`,
            roster[index]!.id,
            m === 0 ? "sender" : "recipient",
            source,
          );
        }
      }
    })();
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  console.log(JSON.stringify({ people, rules: written, documents }));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function summary(values: number[]) {
  return { median: Math.round(median(values)), worst: Math.round(Math.max(...values)) };
}

/** Runs `work` while a 1 ms timer ticks; returns its time and the longest gap between ticks. */
async function withTimer<T>(
  work: () => Promise<T> | T,
): Promise<{ ms: number; gapMs: number; value: T }> {
  let last = performance.now();
  let gapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gapMs = Math.max(gapMs, now - last);
    last = now;
  }, 1);
  // Let the timer tick once so the gap measures the work, not the setup.
  await new Promise((resolve) => setTimeout(resolve, 5));
  last = performance.now();
  gapMs = 0;
  const t = performance.now();
  const value = await work();
  const ms = performance.now() - t;
  clearInterval(timer);
  gapMs = Math.max(gapMs, performance.now() - last);
  return { ms, gapMs, value };
}

async function measure(): Promise<void> {
  const runs = Number(rest[0] ?? 7);
  const keyHex = readFileSync(keyPath, "utf8").trim();
  const main = openReadOnlyDatabase(dbPath, {
    encryptionKey: Buffer.from(keyHex, "hex"),
    cacheSizeBytes: MAIN_READ_CACHE_BYTES,
  });
  const counts = main
    .prepare(
      `SELECT (SELECT COUNT(*) FROM people) AS people,
              (SELECT COUNT(*) FROM person_aliases) AS aliases,
              (SELECT COUNT(*) FROM merge_rules) AS rules,
              (SELECT COUNT(*) FROM document_people) AS mentions`,
    )
    .get();
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: dbPath,
      gatewayDbKeyHex: keyHex,
      concurrency: 1,
      cacheSizeBytes: IO_READ_CACHE_BYTES,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 60_000,
      workerUrl: new URL("../packages/gateway/src/workers/io-worker.ts", import.meta.url),
      workerExecArgv: [
        "--import",
        new URL("../packages/gateway/src/workers/register-tsx.mjs", import.meta.url).href,
      ],
    }),
  );
  await scheduler.start();
  const gate = ioGateFromScheduler(scheduler);
  const service = new PersonService(main as never, {} as WriteGate, {}, gate);
  type Opts = Parameters<PersonService["listMergeRuleGroups"]>[0];
  const load = (opts: Opts) => Promise.resolve(service.listMergeRuleGroups(opts));
  // Warm both handles' caches and the worker's module graph once.
  const firstPage = await load({ limit: 25 });

  const requests: Record<string, () => Opts> = {
    firstPage: () => ({ limit: 25 }),
    secondPage: () => ({ limit: 25, before: firstPage.last! }),
    kindUser: () => ({ limit: 25, kind: "user" }),
    query: () => ({ limit: 25, q: "reeves" }),
  };
  const results: Record<string, { waitMs: number[]; blockedMs: number[] }> = {};
  const outputs: Record<string, string> = {};
  for (let run = 0; run < runs; run++) {
    for (const [name, opts] of Object.entries(requests)) {
      const timed = await withTimer(() => load(opts()));
      const bucket = (results[name] ??= { waitMs: [], blockedMs: [] });
      bucket.waitMs.push(timed.ms);
      bucket.blockedMs.push(timed.gapMs);
      const json = JSON.stringify(timed.value);
      if (outputs[name] !== undefined && outputs[name] !== json)
        throw new Error(`${name} returned a different page on run ${run}`);
      outputs[name] = json;
    }
  }
  const rss = process.memoryUsage().rss;
  await scheduler.dispose();
  main.close();
  console.log(
    JSON.stringify(
      {
        counts,
        runs,
        rssMiB: Math.round(rss / 2 ** 20),
        requests: Object.fromEntries(
          Object.entries(results).map(([name, r]) => [
            name,
            {
              waitMs: summary(r.waitMs),
              blockedMs: summary(r.blockedMs),
              groups: JSON.parse(outputs[name]!).items.length,
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
}

if (mode === "build") build();
else await measure();
// The io runner's worker can keep the process alive after its scheduler is
// disposed; the measurement is printed, so end here.
process.exit(0);
