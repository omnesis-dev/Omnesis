// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, onTestFinished } from "vitest";

const supervisorUrl = new URL("./supervisor.mjs", import.meta.url).href;
async function fixture({ fail, ignoreTerm = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-supervisor-"));
  const events = join(dir, "events");
  await writeFile(events, "");
  const daemon = join(dir, "daemon.mjs");
  await writeFile(
    daemon,
    `
    import { appendFileSync } from 'node:fs';
    const [name, file, fail, ignore] = process.argv.slice(2);
    const log = (event) => appendFileSync(file, name + ':' + event + '\\n');
    process.on('SIGTERM', () => { log('term'); if (ignore !== 'true') process.exit(0); });
    log('ready');
    if (fail === name) setTimeout(() => process.exit(7), 100);
    setInterval(() => {}, 1000);
  `,
  );
  const runner = join(dir, "runner.mjs");
  await writeFile(
    runner,
    `
    import { supervise } from ${JSON.stringify(supervisorUrl)};
    const command = (name) => [process.execPath, ${JSON.stringify(daemon)}, name,
      ${JSON.stringify(events)}, ${JSON.stringify(fail || "")}, ${JSON.stringify(String(ignoreTerm))}];
    process.exitCode = await supervise({gateway: command('gateway'), collector: command('collector'), drainMs: 150});
  `,
  );
  const child = spawn(process.execPath, [runner], { stdio: "pipe" });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await done;
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 200; i++) {
    const log = await readFile(events, "utf8");
    if (log.includes("gateway:ready") && log.includes("collector:ready")) {
      return { child, done, log: () => readFile(events, "utf8") };
    }
    await delay(10);
  }
  throw new Error("Daemons did not start");
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} drains collector before gateway and exits successfully`, async () => {
    const f = await fixture();
    f.child.kill(signal);
    assert.deepEqual(await f.done, { code: 0, signal: null });
    const log = await f.log();
    assert.ok(log.indexOf("collector:term") < log.indexOf("gateway:term"), log);
  });
}
for (const fail of ["gateway", "collector"]) {
  test(`${fail} failure stops its sibling and preserves failure status`, async () => {
    const f = await fixture({ fail });
    assert.deepEqual(await f.done, { code: 7, signal: null });
    assert.match(await f.log(), new RegExp(`${fail === "gateway" ? "collector" : "gateway"}:term`));
  });
}
test("unresponsive daemons are killed after their drain deadline", async () => {
  const f = await fixture({ ignoreTerm: true });
  f.child.kill("SIGTERM");
  assert.deepEqual(await f.done, { code: 0, signal: null });
  assert.match(await f.log(), /collector:term/);
  assert.match(await f.log(), /gateway:term/);
});
test("spawn failure terminates the service", async () => {
  const { supervise } = await import(supervisorUrl);
  assert.equal(
    await supervise({
      gateway: ["/nonexistent-omnesis"],
      collector: ["/nonexistent-omnesis"],
      drainMs: 100,
    }),
    1,
  );
});
