// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { deserialize } from "node:v8";
import type { Readable } from "node:stream";
export const DESKTOP_DATA_INPUT_LIMIT = 72 * 1024 * 1024;
const refused = () => new Error("The private data-operation request is invalid");

/** One bounded binary frame; stdin remains open as the controller-liveness channel. */
export function readDesktopDataFrame(input: Readable, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let header = Buffer.alloc(0),
      expected: number | undefined,
      size = 0;
    const blocks: Buffer[] = [];
    const cleanup = () => {
      input.off("data", receive);
      input.off("end", fail);
      input.off("error", fail);
      input.off("close", fail);
      signal.removeEventListener("abort", fail);
      header.fill(0);
      for (const block of blocks) block.fill(0);
    };
    const fail = () => {
      cleanup();
      reject(refused());
    };
    const receive = (value: Buffer) => {
      let block = value;
      if (expected === undefined) {
        const take = Math.min(4 - header.length, block.length);
        header = Buffer.concat([header, block.subarray(0, take)]);
        block = block.subarray(take);
        if (header.length < 4) return;
        expected = header.readUInt32BE();
        if (expected < 1 || expected > DESKTOP_DATA_INPUT_LIMIT) return fail();
      }
      size += block.length;
      if (size > expected) return fail();
      if (block.length) blocks.push(Buffer.from(block));
      if (size === expected) {
        const frame = Buffer.concat(blocks, size);
        try {
          // A deep clone detaches any Buffer views from the wiped transport frame.
          const result: unknown = structuredClone(deserialize(frame));
          input.pause();
          cleanup();
          resolve(result);
        } catch {
          fail();
        } finally {
          frame.fill(0);
        }
      }
    };
    if (signal.aborted) return fail();
    input.on("data", receive);
    input.once("end", fail);
    input.once("error", fail);
    input.once("close", fail);
    signal.addEventListener("abort", fail, { once: true });
  });
}
