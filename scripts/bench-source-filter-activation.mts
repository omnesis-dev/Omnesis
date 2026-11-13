// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How long an account's folder picker takes to become ready when source
 * filters are switched on over records that are already indexed.
 *
 *   npx tsx scripts/bench-source-filter-activation.mts <source> <count> [folders=300] [legacy]
 *
 * `source` is `codex` or `local-files`. The script boots an isolated gateway
 * and collector through `SyntheticE2EHarness`, which runs the real provider
 * over a directory of invented files, and adds `count` sessions or files to
 * that directory, spread over `folders` nested project folders. Session files
 * are a mix of small, medium and multi-megabyte transcripts, most of whose
 * bytes are tool output the parser discards. Codex stands for the three
 * coding-agent sources: they share the scanning, paging and folder code and
 * differ only in how one file is parsed.
 *
 * It then follows the upgrade the way `source-filter-upgrade.ts` does: the
 * records are indexed while the gateway takes no filter facts, the collector
 * goes offline, the gateway restarts with filters in use, and the collector
 * comes back. Nothing triggers a sync or the gateway's background pass; both
 * run on their own schedule, as they do for an owner.
 *
 * With `legacy`, the directory each session worked in is removed from the
 * collector's stored state first, which is the state a version that did not
 * record directories left behind: the collector has to read every session
 * file once more to file it.
 *
 * Reported: how long the gateway's own pass over the stored records takes
 * before any collector is back, and then, from the collector's return until
 * the folder picker is ready, the wall time, the collector's CPU time and the
 * bytes its process read (files, sockets and the gateway's piped log
 * together), every page it sent (count, records, folder facts, cursor bytes,
 * time spent waiting for the gateway), the gateway's CPU time, and the
 * main-thread stalls the gateway recorded. The gateway applies a page's
 * folder facts one record per writer transaction, so the time a page waits is
 * many short holds of the writer and not one long one.
 *
 * Set `TMPDIR` to a scratch directory with room for the generated files. The
 * harness never touches a live gateway: it boots its own on a free port and a
 * temporary configuration directory, and removes both when it ends.
 */

import "../packages/collector/src/e2e/synth-env.js";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { HttpGatewayClient } from "@omnesis/gateway-client";
import { SyntheticE2EHarness } from "../packages/collector/src/e2e/synth-harness.js";

const ACCOUNTS: Record<string, string> = {
  codex: "codex:codex-maya",
  "local-files": "local-files:files-maya",
};

const [sourceType = "", countArg = "", foldersArg = "300", mode = ""] = process.argv.slice(2);
const count = Number(countArg);
const folderCount = Number(foldersArg);
const sourceId = ACCOUNTS[sourceType];
if (!sourceId || !Number.isInteger(count) || count < 1 || !Number.isInteger(folderCount)) {
  console.error(
    "usage: bench-source-filter-activation.mts codex|local-files <count> [folders] [legacy]",
  );
  process.exit(2);
}

/** Deterministic pseudo-random numbers, so two runs generate the same files. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const AREAS = ["work", "personal", "labs", "clients", "archive"];
const TEAMS = ["atlas", "harbor", "meadow", "quartz", "lantern", "juniper"];
/** Invented project folders, nested two to four levels below an area. */
function projectFolders(total: number): string[] {
  const folders: string[] = [];
  for (let index = 0; folders.length < total; index++) {
    const area = AREAS[index % AREAS.length]!;
    const team = TEAMS[Math.floor(index / AREAS.length) % TEAMS.length]!;
    const project = `project-${String(Math.floor(index / (AREAS.length * TEAMS.length))).padStart(3, "0")}`;
    const depth = index % 3;
    folders.push(
      [
        area,
        team,
        project,
        ...(depth > 0 ? ["packages"] : []),
        ...(depth > 1 ? ["core"] : []),
      ].join("/"),
    );
  }
  return folders;
}

/** A transcript size in bytes: mostly small, some medium, a few multi-megabyte. */
function transcriptBytes(next: () => number): number {
  const roll = next();
  if (roll < 0.8) return 20_000 + Math.floor(next() * 40_000);
  if (roll < 0.97) return 300_000 + Math.floor(next() * 700_000);
  return 3_000_000 + Math.floor(next() * 3_000_000);
}

const NOISE = "invented tool output line that the transcript parser discards. ".repeat(64);
const at = (index: number, step: number): string =>
  new Date(Date.UTC(2026, 0, 1 + (index % 300), 9, 0, step)).toISOString();

/** The records of one Codex session, padded to `bytes` with tool output. */
function sessionLines(index: number, cwd: string, bytes: number): string {
  const id = `bench-codex-${String(index).padStart(6, "0")}`;
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: at(index, 0),
      payload: { id, source: "cli", cwd },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: at(index, 1),
      payload: {
        type: "user_message",
        message: `zqbench PROMPT_${index} How should the invented service number ${index} page its results?`,
      },
    }),
  ];
  let size = lines.reduce((total, line) => total + line.length + 1, 0);
  for (let step = 0; size < bytes; step++) {
    const line = JSON.stringify({
      type: "response_item",
      timestamp: at(index, 2),
      payload: { type: "function_call_output", call_id: `call-${step}`, output: NOISE },
    });
    lines.push(line);
    size += line.length + 1;
  }
  lines.push(
    JSON.stringify({
      type: "response_item",
      timestamp: at(index, 3),
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [
          {
            type: "output_text",
            text: `zqbench ANSWER_${index} Return an opaque cursor and keep the page size fixed.`,
          },
        ],
      },
    }),
  );
  return `${lines.join("\n")}\n`;
}

/** The directory holding the invented input files of `type`, created by its source. */
function inputRoot(configDir: string, type: string): string {
  const wanted = `synthetic-${type}`;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 4) return null;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === wanted) return path;
      const found = walk(path, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const found = walk(configDir, 0);
  if (!found) throw new Error(`No ${wanted} directory under ${configDir}`);
  return found;
}

function generate(root: string): { files: number; bytes: number } {
  const next = random(count);
  const folders = projectFolders(folderCount);
  let bytes = 0;
  for (let index = 0; index < count; index++) {
    const folder = folders[Math.floor(next() * folders.length)]!;
    let path: string;
    let content: string;
    if (sourceType === "local-files") {
      path = join(root, folder, `note-${String(index).padStart(6, "0")}.md`);
      content = `# Invented note ${index}\n\nzqbench BODY_${index} ${"Fictional planning text for the bench. ".repeat(20 + Math.floor(next() * 200))}\n`;
    } else {
      const day = String(1 + (index % 28)).padStart(2, "0");
      path = join(
        root,
        "sessions",
        "2026",
        "01",
        day,
        `rollout-${String(index).padStart(6, "0")}.jsonl`,
      );
      content = sessionLines(index, `/srv/${folder}`, transcriptBytes(next));
    }
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    bytes += content.length;
  }
  return { files: count, bytes };
}

interface PageSample {
  ms: number;
  documents: number;
  facts: number;
  cursorBytes: number;
}
const pages: PageSample[] = [];
let recording = false;
const originalUpsert = HttpGatewayClient.prototype.upsertWithCursor;
HttpGatewayClient.prototype.upsertWithCursor = async function (this: HttpGatewayClient, input) {
  const started = performance.now();
  try {
    return await originalUpsert.call(this, input);
  } finally {
    if (recording && input.sourceId === sourceId)
      pages.push({
        ms: performance.now() - started,
        documents: input.documents.length,
        facts: input.scopeUpdates?.hierarchy?.documents?.length ?? 0,
        cursorBytes: JSON.stringify(input.cursor ?? null).length,
      });
  }
};

const selfIo = (): number =>
  Number(/^rchar: (\d+)/m.exec(readFileSync("/proc/self/io", "utf8"))?.[1] ?? 0);
/** CPU time of a process and of every process it started, in milliseconds. */
function processCpuMs(pid: number): number {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
  let total = ((Number(fields[11]) + Number(fields[12])) * 1000) / 100;
  for (const task of readdirSync(`/proc/${pid}/task`))
    for (const child of readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").split(" "))
      if (child) total += processCpuMs(Number(child));
  return total;
}
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

const harness = new SyntheticE2EHarness({ gatewayMode: "synthetic", universe: "folder-filters" });
try {
  await harness.start();
  const generated = generate(inputRoot(harness.getConfigDir(), sourceType));
  console.log(
    `${sourceType}: ${generated.files} generated in ${folderCount} folders, ${megabytes(generated.bytes)}`,
  );

  let started = performance.now();
  await harness.triggerSyncAndWait(sourceId, 4 * 60 * 60 * 1000);
  console.log(`first index, filters not in use: ${seconds(performance.now() - started)}`);
  started = performance.now();
  await harness.triggerSyncAndWait(sourceId, 60 * 60 * 1000);
  console.log(`second sync, nothing new: ${seconds(performance.now() - started)}`);

  const read = <T,>(query: (db: Database.Database) => T): T => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return query(db);
    } finally {
      db.close();
    }
  };
  const stored = read(
    (db) =>
      db
        .prepare<[string], { n: number }>("SELECT count(*) AS n FROM documents WHERE source_id=?")
        .get(sourceId)!.n,
  );
  console.log(`records stored: ${stored}`);

  await harness.disconnectCollectors();
  await harness.restartGateway({
    gatewayMode: "synthetic-experimental",
    whileStopped: () => {
      if (mode !== "legacy") return;
      const db = new Database(harness.getDbPath());
      try {
        const rows = db
          .prepare<[string], { device_id: string; cursor: string }>(
            "SELECT device_id,cursor FROM sync_state WHERE source_id=?",
          )
          .all(sourceId);
        let stripped = 0;
        const strip = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            if (key === "files" && child && typeof child === "object") {
              for (const file of Object.values(child as Record<string, { directory?: unknown }>))
                if (file && "directory" in file) {
                  delete file.directory;
                  stripped++;
                }
            } else strip(child);
          }
        };
        for (const row of rows) {
          const cursor: unknown = JSON.parse(row.cursor);
          strip(cursor);
          db.prepare("UPDATE sync_state SET cursor=? WHERE source_id=? AND device_id=?").run(
            JSON.stringify(cursor),
            sourceId,
            row.device_id,
          );
        }
        if (stripped === 0)
          throw new Error(
            `The stored state records no directory: ${rows.map((row) => `${row.device_id}=${row.cursor.slice(0, 200)}`).join(" | ")}`,
          );
        console.log(`directories removed from the stored state of ${stripped} session files`);
      } finally {
        db.close();
      }
    },
  });
  const gatewayPid = harness.gatewayPid!;

  const ready = (): { collector: boolean; gateway: boolean; working: boolean; filed: number } =>
    read((db) => ({
      working: !!db.prepare("SELECT 1 FROM scope_hierarchy_dirty LIMIT 1").get(),
      collector: !!db
        .prepare(
          "SELECT 1 FROM source_scope_kind_readiness WHERE source_id=? AND kind='folder' AND ready=1",
        )
        .get(sourceId),
      gateway: !!db
        .prepare("SELECT 1 FROM scope_fact_backfill WHERE source_id=? AND ready=1")
        .get(sourceId),
      filed: db
        .prepare<[string], { n: number }>(
          `SELECT count(*) AS n FROM document_scope_completeness c JOIN documents d ON d.id=c.document_id
           WHERE d.source_id=? AND c.kind='folder'`,
        )
        .get(sourceId)!.n,
    }));

  // The gateway's own pass over the records it stores starts by itself and
  // needs no collector.
  started = performance.now();
  while (!ready().gateway) {
    if (performance.now() - started > 4 * 60 * 60 * 1000)
      throw new Error("The gateway's own pass did not end in four hours");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const ownPass = performance.now() - started;
  console.log(
    `gateway's own pass over ${stored} stored records: ${seconds(ownPass)} (${Math.round(stored / (ownPass / 1000))} records/s)`,
  );

  const cpu = process.cpuUsage();
  const io = selfIo();
  const gatewayCpu = processCpuMs(gatewayPid);
  recording = true;
  started = performance.now();
  await harness.reconnectCollectors();
  let collectorReadyAt: number | null = null;
  let last = 0;
  for (;;) {
    const state = ready();
    const elapsed = performance.now() - started;
    if (state.collector && collectorReadyAt === null) collectorReadyAt = elapsed;
    if (state.collector && state.gateway && !state.working) break;
    if (elapsed - last > 30_000) {
      last = elapsed;
      console.log(
        `  ${seconds(elapsed)}: ${pages.length} pages, ${state.filed}/${stored} filed, collector ${state.collector ? "done" : "reporting"}`,
      );
    }
    if (elapsed > 4 * 60 * 60 * 1000) throw new Error("Not ready after four hours");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const total = performance.now() - started;
  recording = false;
  const used = process.cpuUsage(cpu);
  const stalls = await harness.gatewayJson<{
    ranking?: Array<{ culprit: string | null; count: number; totalMs: number; worstMs: number }>;
  }>("/admin/stalls?windowMinutes=1440");

  const withDocuments = pages.filter((page) => page.documents > 0);
  console.log(`picker ready after: ${seconds(total)}`);
  console.log(`  collector had reported everything after: ${seconds(collectorReadyAt ?? total)}`);
  console.log(`  gateway settled the rest in: ${seconds(total - (collectorReadyAt ?? total))}`);
  console.log(
    `collector: ${seconds((used.user + used.system) / 1000)} CPU, ${megabytes(selfIo() - io)} read`,
  );
  console.log(
    `pages sent: ${pages.length} (${withDocuments.length} re-sent records, ${sum(withDocuments.map((page) => page.documents))} records in all), ` +
      `${sum(pages.map((page) => page.facts))} folder facts, ${megabytes(sum(pages.map((page) => page.cursorBytes)))} of cursor`,
  );
  const times = pages.map((page) => page.ms).sort((a, b) => a - b);
  console.log(
    `time in the gateway per page: median ${times[Math.floor(times.length / 2)]?.toFixed(0)} ms, ` +
      `worst ${times.at(-1)?.toFixed(0)} ms, total ${seconds(sum(times))}`,
  );
  console.log(`gateway: ${seconds(processCpuMs(gatewayPid) - gatewayCpu)} CPU`);
  console.log(
    `gateway main-thread stalls: ${
      (stalls.ranking ?? [])
        .map((row) => `${row.culprit ?? "unnamed"} ×${row.count} worst ${row.worstMs} ms`)
        .join("; ") || "none recorded"
    }`,
  );
  const log = harness.getGatewayLogPath();
  console.log(`gateway log: ${log} (${megabytes(statSync(log).size)})`);
} finally {
  await harness.destroy();
}
