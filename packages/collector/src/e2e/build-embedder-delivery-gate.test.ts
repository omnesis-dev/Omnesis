// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { fork } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { createBuildEmbedderDeliveryGate } from "./build-embedder-delivery-gate.js";

test.each(["release", "close"] as const)(
  "delivery gate holds only native build results and joins workers after %s",
  async (finish) => {
    const root = mkdtempSync(join(tmpdir(), "embedding gate fixture "));
    const gate = await createBuildEmbedderDeliveryGate();
    const preload = new URL("./build-embedder-delivery-gate.mjs", import.meta.url);
    const spacedPreload = join(root, "preload with spaces.mjs");
    cpSync(preload, spacedPreload);
    const env = {
      ...gate.env,
      NODE_OPTIONS: gate.env.NODE_OPTIONS.replace(
        JSON.stringify(preload.href),
        JSON.stringify(pathToFileURL(spacedPreload).href),
      ),
    };
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(root, "build-embedder-worker.js"),
      `
import {parentPort} from 'node:worker_threads';
for(const message of [{type:'ready'},{type:'embedResult',id:1,vectors:[[7,8]]},{type:'embedError',id:2,error:'invented failure'},{type:'shutdownComplete'}])parentPort.postMessage(message);
parentPort.on('message',()=>{});
`,
    );
    writeFileSync(
      join(root, "indexer-worker.js"),
      `
import {parentPort} from 'node:worker_threads';parentPort.postMessage({type:'embedResult',vectors:[[9]]});parentPort.on('message',()=>{});
`,
    );
    writeFileSync(
      join(root, "runner.mjs"),
      `
import assert from 'node:assert/strict';import {Worker} from 'node:worker_threads';
const target=new Worker(new URL('./build-embedder-worker.js',import.meta.url));
const other=new Worker(new URL('./indexer-worker.js',import.meta.url));
const seen=[];let reported=false;
function report(){if(!reported&&seen.includes('ready')&&seen.includes('embedError')&&seen.includes('shutdownComplete')&&seen.includes('unrelated')){reported=true;process.send({phase:'controls',seen:[...seen]});}}
target.on('message',async message=>{seen.push(message.type);if(message.type==='embedResult'){assert.deepEqual(message.vectors,[[7,8]]);process.send({phase:'released'});await Promise.all([target.terminate(),other.terminate()]);process.disconnect();}report();});
other.on('message',message=>{assert.equal(message.type,'embedResult');seen.push('unrelated');report();});
`,
    );
    const child = fork(join(root, "runner.mjs"), [], {
      execArgv: [],
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const exited = once(child, "exit");
    try {
      const controls = once(child, "message");
      await gate.held;
      const [first] = await controls;
      expect(first).toEqual({
        phase: "controls",
        seen: expect.arrayContaining(["ready", "embedError", "shutdownComplete", "unrelated"]),
      });
      expect((first as { seen: string[] }).seen).not.toContain("embedResult");
      const released = once(child, "message");
      if (finish === "release") gate.release();
      else await gate.close();
      expect((await released)[0]).toEqual({ phase: "released" });
      expect(await exited).toEqual([0, null]);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      await gate.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);

test("unauthenticated and oversized clients cannot release or poison the fixture gate", async () => {
  const gate = await createBuildEmbedderDeliveryGate();
  const config = JSON.parse(gate.env.OMNESIS_E2E_BUILD_DELIVERY_GATE) as {
    port: number;
    nonce: string;
  };
  try {
    for (const data of ["held:invented-wrong-nonce\n", "x".repeat(257)]) {
      const bad = connect({ host: "127.0.0.1", port: config.port });
      bad.on("error", () => {});
      const closed = once(bad, "close");
      bad.write(data);
      await closed;
    }
    const valid = connect({ host: "127.0.0.1", port: config.port });
    const released = once(valid, "data");
    valid.write(`held:${config.nonce}\n`);
    await gate.held;
    gate.release();
    expect((await released)[0].toString()).toBe(`release:${config.nonce}\n`);
    valid.destroy();
  } finally {
    await gate.close();
  }
});
