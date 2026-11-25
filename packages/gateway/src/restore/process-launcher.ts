// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { serialize } from "node:v8";
import {
  resolveSubprocessEntry,
  spawnOwnedChildProcess,
  type ManagedDesktopDataScope,
} from "@omnesis/core";

export async function runRestoreProcess(
  options: unknown,
  signal: AbortSignal,
  dependencies: {
    entry?: () => ReturnType<typeof resolveSubprocessEntry>;
    dataScope?: Omit<ManagedDesktopDataScope, "format">;
    spawn?: typeof spawnOwnedChildProcess;
  } = {},
): Promise<unknown> {
  signal.throwIfAborted();
  const frame = serialize(options);
  if (frame.length > 72 * 1024 * 1024) {
    frame.fill(0);
    throw new Error("The backup database exceeds the restore input limit");
  }
  let owner: ReturnType<typeof spawnOwnedChildProcess>;
  try {
    const entry =
      dependencies.entry?.() ??
      resolveSubprocessEntry("./process-worker.ts", import.meta.url, dependencies.dataScope);
    owner = (dependencies.spawn ?? spawnOwnedChildProcess)(entry.command, entry.args, {
      env: process.env,
    });
  } catch {
    frame.fill(0);
    throw new Error("The backup database process could not be started safely");
  }
  const child = owner.child;
  let cancelled = false,
    refused = false,
    output = "",
    exitCode: number | null = null;
  const stop = () => {
    cancelled = true;
    void owner.stop().catch(() => undefined);
  };
  const timeout = setTimeout(stop, 60 * 60_000);
  timeout.unref();
  child.stderr?.resume();
  child.stdout?.on("data", (block: Buffer) => {
    if (Buffer.byteLength(output) + block.length > 64 * 1024) {
      refused = true;
      void owner.stop().catch(() => undefined);
      return;
    }
    output += block.toString("utf8");
  });
  child.once("exit", (code) => {
    exitCode = code;
  });
  // Pipe errors are deliberately content-free; actual process closure is still awaited.
  child.stdin?.on("error", () => {
    refused = true;
  });
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) stop();
    await owner.ready;
    if (!cancelled) {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(frame.length);
      await new Promise<void>((resolve, reject) => {
        if (!child.stdin) {
          reject(new Error("The restore process has no private input"));
          return;
        }
        child.stdin.write(header);
        child.stdin.write(frame, (error) =>
          error ? reject(new Error("The restore process refused its private input")) : resolve(),
        );
      });
    }
    await owner.joined;
    if (cancelled || signal.aborted)
      throw new DOMException("Backup restore was cancelled", "AbortError");
    if (refused || exitCode !== 0)
      throw new Error("The backup database could not be prepared safely");
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new Error("The backup database could not be prepared safely");
    }
  } finally {
    frame.fill(0);
    clearTimeout(timeout);
    signal.removeEventListener("abort", stop);
    // Never release the caller's runtime leases while a native operation can still write.
    if (!owner.joinedConfirmed) await owner.stop();
    child.stdin?.destroy();
  }
}
