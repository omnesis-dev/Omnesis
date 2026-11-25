// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { serialize } from "node:v8";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { desktopProfile } from "./environment.js";
import { readDesktopDataFrame, DESKTOP_DATA_INPUT_LIMIT } from "./data-operation-frame.js";
import { runDesktopDataOperation, type DesktopDataRequest } from "./data-operation-channel.js";
import { handleDesktopDataOperation } from "./data-operation-handler.js";

const signal = () => new AbortController().signal;
const request = (): DesktopDataRequest => ({
  version: 1,
  purpose: "erase",
  operationId: randomUUID(),
  profile: desktopProfile("/tmp/omnesis-data-operation-fixture"),
  payload: {},
});
function encoded(value: unknown): Buffer {
  const data = serialize(value),
    header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}
test("private frames tolerate chunk boundaries and detach transport buffers before wiping", async () => {
  const input = new PassThrough(),
    data = encoded({
      key: "invented-private-key",
      bytes: Buffer.from("sample"),
      map: new Map([["row", 1]]),
    });
  const read = readDesktopDataFrame(input, signal());
  for (let offset = 0; offset < data.length; offset += 3)
    input.write(data.subarray(offset, offset + 3));
  const value = (await read) as { key: string; bytes: Uint8Array; map: Map<string, number> };
  expect(value.key).toBe("invented-private-key");
  expect(Buffer.from(value.bytes).toString()).toBe("sample");
  expect(value.map.get("row")).toBe(1);
  input.destroy();
});
test.each(["truncated", "oversized", "invalid", "extra"])(
  "private frame refuses %s input without echoing it",
  async (kind) => {
    const input = new PassThrough(),
      read = readDesktopDataFrame(input, signal());
    const result = expect(read).rejects.toThrow("private data-operation request is invalid");
    if (kind === "truncated") input.end(Buffer.from([0, 0, 0]));
    else if (kind === "oversized") {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(DESKTOP_DATA_INPUT_LIMIT + 1);
      input.write(header);
    } else if (kind === "invalid") input.write(Buffer.from([0, 0, 0, 3, 99, 98, 97]));
    else input.write(Buffer.concat([encoded({}), Buffer.from("private-extra")]));
    await result;
    input.destroy();
  },
);
test("cancelled frame intake rejects without waiting for EOF", async () => {
  const input = new PassThrough(),
    controller = new AbortController();
  const read = readDesktopDataFrame(input, controller.signal);
  controller.abort();
  await expect(read).rejects.toThrow("invalid");
  input.destroy();
});

test("a pipe closed without EOF cannot strand frame intake", async () => {
  const input = new PassThrough(),
    read = readDesktopDataFrame(input, signal());
  const rejected = expect(read).rejects.toThrow("request is invalid");
  input.destroy();
  await rejected;
});

test("frame intake pauses before handoff so late extra input cannot disappear", async () => {
  const input = new PassThrough(),
    read = readDesktopDataFrame(input, signal());
  input.write(encoded({ version: 1 }));
  await read;
  expect(input.isPaused()).toBe(true);
  input.write(Buffer.from("extra"));
  const seen: Buffer[] = [];
  input.on("data", (block: Buffer) => seen.push(block));
  input.resume();
  await delay(0);
  expect(Buffer.concat(seen).toString()).toBe("extra");
  input.destroy();
});
test("native authority is checked before dispatch, and no arbitrary action is accepted", async () => {
  const erase = vi.fn(async () => ({
      status: "retired" as const,
      data: "erased" as const,
      keyring: "cleared" as const,
    })),
    authorize = vi.fn(() => {
      throw new Error("authority absent");
    });
  await expect(
    handleDesktopDataOperation(request(), signal(), { authorize, erase }),
  ).rejects.toThrow("authority absent");
  expect(erase).not.toHaveBeenCalled();
  await expect(
    handleDesktopDataOperation(
      { ...request(), purpose: "eval", payload: { module: "private" } },
      signal(),
      { authorize, erase },
    ),
  ).rejects.toThrow();
  expect(authorize).toHaveBeenCalledTimes(1);
  const input = request();
  await handleDesktopDataOperation(input, signal(), { authorize: () => {}, erase });
  expect(erase).toHaveBeenCalledWith(input.profile, input.operationId, expect.any(AbortSignal));
});
test("source controllers cannot silently bypass the native operation lease", async () => {
  const spawn = vi.fn();
  await expect(runDesktopDataOperation(request(), signal(), { spawn })).rejects.toThrow(
    "protected data operation did not finish",
  );
  expect(spawn).not.toHaveBeenCalled();
});
const receive = `const {deserialize}=require('node:v8');let chunks=[],n=0;process.stdin.on('data',b=>{chunks.push(b);const all=Buffer.concat(chunks);if(all.length>=4&&all.length===4+all.readUInt32BE()){process.stdin.removeAllListeners('data');const request=deserialize(all.subarray(4));`;
test("large private input obeys pipe backpressure, and a reply does not substitute for physical exit", async () => {
  const input = request();
  input.payload = { sourceRootKey: "invented-private-key", padding: "x".repeat(8 * 1024 * 1024) };
  const invocation = vi.fn(() => ({
    command: process.execPath,
    args: [
      "-e",
      `${receive}process.stdout.write(JSON.stringify({version:1,ok:true,result:{bytes:request.payload.padding.length}}));setTimeout(()=>process.exit(0),150);}});`,
    ],
  }));
  let done = false;
  const pending = runDesktopDataOperation(input, signal(), { invocation }).then((result) => {
    done = true;
    return result;
  });
  await delay(50);
  expect(done).toBe(false);
  expect(await pending).toEqual({ bytes: 8 * 1024 * 1024 });
  expect(invocation.mock.results[0]!.value.args.join(" ")).not.toContain("invented-private-key");
});
test("host stdout and raw exception details cannot become a successful result", async () => {
  const invocation = () => ({
    command: process.execPath,
    args: [
      "-e",
      `${receive}process.stdout.write('invented-secret-error'.repeat(10000));setInterval(()=>{},1000);}});`,
    ],
  });
  await expect(runDesktopDataOperation(request(), signal(), { invocation })).rejects.toThrow(
    /^The protected data operation did not finish/,
  );
});
test("cancellation joins the exact owned host even when it ignores graceful stop", async () => {
  const controller = new AbortController();
  const invocation = () => ({
    command: process.execPath,
    args: [
      "-e",
      `process.on('SIGTERM',()=>{});${receive}process.stdout.write(JSON.stringify({version:1,ok:true,result:{}}));setInterval(()=>{},1000);}});`,
    ],
  });
  const pending = runDesktopDataOperation(request(), controller.signal, { invocation });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await delay(150);
  controller.abort();
  await rejected;
}, 10_000);
