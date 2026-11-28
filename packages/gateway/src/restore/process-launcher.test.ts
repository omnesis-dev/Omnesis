// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveSubprocessEntry, spawnOwnedChildProcess } from "@omnesis/core";
import { runRestoreProcess } from "./process-launcher.js";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-restore-process-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const fixture = (script: string) => () => ({
  command: process.execPath,
  args: ["--input-type=module", "-e", script],
});
test("uses bounded private binary input and waits for physical child exit after metadata arrives", async () => {
  const closed = join(directory, "closed"),
    secret = "invented-private-value",
    key = Buffer.alloc(32, 7);
  const entry = fixture(`import {deserialize} from 'node:v8';import{writeFileSync}from'node:fs';
    let blocks=[],bytes=0,expected;
    process.stdin.on('data',block=>{blocks.push(block);bytes+=block.length;const raw=Buffer.concat(blocks);
      if(raw.length>=4)expected=raw.readUInt32BE();
      if(expected && bytes===expected+4){const input=deserialize(raw.subarray(4));
        if(!Buffer.isBuffer(input.key)||input.key[0]!==7||input.secret.length!==22)process.exit(70);
        process.stdout.write(JSON.stringify({ok:true,result:{received:true}}));
        setTimeout(()=>{writeFileSync(${JSON.stringify(closed)},'closed');process.exit(0)},150);
      }});`);
  const spawn = vi.fn(spawnOwnedChildProcess);
  expect(
    await runRestoreProcess({ key, secret }, new AbortController().signal, { entry, spawn }),
  ).toEqual({ ok: true, result: { received: true } });
  expect(await readFile(closed, "utf8")).toBe("closed");
  expect(spawn.mock.calls[0]?.[1].join(" ")).not.toContain(secret);
  expect(key).toEqual(Buffer.alloc(32, 7));
});

test("a worker that ignores SIGTERM is killed and physically joined before cancellation returns", async () => {
  const ready = join(directory, "ready"),
    controller = new AbortController();
  const entry = fixture(`import{writeFileSync}from'node:fs';import{Worker}from'node:worker_threads';
    process.on('SIGTERM',()=>{});process.stdin.resume();
    new Worker('while(true){}',{eval:true});writeFileSync(${JSON.stringify(ready)},'ready');`);
  let owned: ReturnType<typeof spawnOwnedChildProcess> | undefined;
  const promise = runRestoreProcess({ key: Buffer.alloc(32, 1) }, controller.signal, {
    entry,
    spawn: (...args) => {
      owned = spawnOwnedChildProcess(...args);
      return owned;
    },
  });
  const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(async () => expect(await readFile(ready, "utf8")).toBe("ready"));
  controller.abort();
  await rejected;
  expect(owned?.joinedConfirmed).toBe(true);
}, 15000);

test("the real process refuses an incomplete frame when its parent closes stdin", async () => {
  const entry = resolveSubprocessEntry("./process-worker.ts", import.meta.url);
  const owner = spawnOwnedChildProcess(entry.command, entry.args, { env: process.env });
  owner.child.stdout?.resume();
  owner.child.stderr?.resume();
  const code = new Promise<number | null>((resolve) => owner.child.once("exit", resolve));
  try {
    await owner.ready;
    owner.child.stdin!.end(Buffer.from([0, 1]));
    await owner.joined;
    expect(await code).toBe(70);
    expect(owner.joinedConfirmed).toBe(true);
  } finally {
    await owner.stop();
  }
});
