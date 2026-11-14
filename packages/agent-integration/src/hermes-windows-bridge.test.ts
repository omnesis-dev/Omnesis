// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
function fixture(): { root: string; bridge: string } {
  const root = mkdtempSync(join(tmpdir(), "hermes-node-bridge-"));
  roots.push(root);
  mkdirSync(join(root, "runtime"));
  writeFileSync(join(root, "runtime/package.json"), '{"type":"module"}');
  cpSync(new URL("../hermes/windows-files.mjs", import.meta.url), join(root, "windows-files.mjs"));
  for (const name of ["refresh-lease", "request-budgets"])
    writeFileSync(
      join(root, `runtime/${name}.js`),
      stripTypeScriptTypes(readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8")),
    );
  // Only the native filesystem boundary is substituted here. Production ships
  // the canonical generated graph; its ACL behavior has separate native tests.
  writeFileSync(
    join(root, "runtime/windows-files.js"),
    `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
export function privateWindowsFiles(){return {
readWindowsPrivateFileContentsSync: readFileSync,
secureWindowsPrivatePathSync(path,kind){appendFileSync(new URL('./calls.jsonl',import.meta.url),JSON.stringify({path,kind})+'\\n')},
writeWindowsPrivateFileAtomicSync(path,bytes){if(bytes.toString()==='invented-rejected-secret')throw Object.assign(new Error(bytes.toString()),{code:'EPRIVATE'});writeFileSync(path,bytes)}
}}`,
  );
  return { root, bridge: join(root, "windows-files.mjs") };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("standalone bridge passes binary bytes on pipes and sanitizes failed secret writes", () => {
  const { root, bridge } = fixture();
  const path = join(root, "literal [$&] 雪.json");
  const bytes = Buffer.from([0, 255, 10, 65]);
  expect(spawnSync(process.execPath, [bridge, "write", path], { input: bytes }).status).toBe(0);
  const read = spawnSync(process.execPath, [bridge, "read", path]);
  expect(read.status).toBe(0);
  expect(read.stdout).toEqual(bytes);
  const failed = spawnSync(process.execPath, [bridge, "write", path], {
    input: "invented-rejected-secret",
  });
  expect(failed.status).toBe(1);
  expect(failed.stdout.length).toBe(0);
  expect(failed.stderr.toString()).not.toContain("invented-rejected-secret");
  expect(readFileSync(path)).toEqual(bytes);
});

test("bridge holds the actual shared lease until release pipe EOF, then joins and removes it", async () => {
  const { root, bridge } = fixture();
  const path = join(root, "credentials.json");
  const child = spawn(process.execPath, [bridge, "lease", path], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    const [ready] = await once(child.stdout, "data");
    expect(ready.toString()).toBe('{"ready":true}\n');
    expect(readFileSync(`${path}.refresh.lock`, "utf8").trim()).toBe(String(child.pid));
    child.stdin.end();
    expect(await exited).toEqual([0, null]);
    expect(existsSync(`${path}.refresh.lock`)).toBe(false);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
  }
});

test("EOF while waiting cancels the bridge without reclaiming another process lease", async () => {
  const { root, bridge } = fixture();
  const path = join(root, "credentials.json");
  const lock = `${path}.refresh.lock`;
  writeFileSync(lock, `${process.pid}\n`);
  const child = spawn(process.execPath, [bridge, "lease", path], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    child.stdin.end();
    expect((await exited)[0]).toBe(1);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
  }
});

test("state preparation secures the directory before existing DB/sidecars and permits missing files", () => {
  const { root, bridge } = fixture();
  const path = join(root, "state.sqlite");
  writeFileSync(path, "invented retained bytes");
  writeFileSync(path + "-shm", "invented retained shared memory");
  const result = spawnSync(process.execPath, [bridge, "state", path]);
  expect(result.status).toBe(0);
  const calls = readFileSync(join(root, "runtime/calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toEqual([
    { path: root, kind: "directory" },
    { path, kind: "file" },
    { path: path + "-shm", kind: "file" },
  ]);
  expect(readFileSync(path, "utf8")).toBe("invented retained bytes");
});
