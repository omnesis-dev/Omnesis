// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { serialize } from "node:v8";
import { spawnOwnedChildProcess, type NodeCommandInvocation } from "@omnesis/core";
interface OwnedFrameOptions {
  request: unknown;
  inputLimit: number;
  outputLimit: number;
  env: NodeJS.ProcessEnv;
  invocation(): NodeCommandInvocation;
  refused(): Error;
  failure?(code: unknown): Error | null;
  spawn?: typeof spawnOwnedChildProcess;
}
/** Fixed-purpose wrappers supply the invocation; request bytes can never select a task or module. */
export async function runOwnedDesktopFrame(
  options: OwnedFrameOptions,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const frame = serialize(options.request);
  if (frame.length > options.inputLimit) {
    frame.fill(0);
    throw options.refused();
  }
  let owner: ReturnType<typeof spawnOwnedChildProcess>;
  try {
    const invocation = options.invocation();
    owner = (options.spawn ?? spawnOwnedChildProcess)(invocation.command, invocation.args, {
      env: options.env,
    });
  } catch {
    frame.fill(0);
    throw options.refused();
  }
  const child = owner.child;
  let cancelled = false,
    invalid = false,
    output = Buffer.alloc(0),
    exit: number | null = null;
  const stop = () => {
    cancelled = true;
    void owner.stop().catch(() => undefined);
  };
  const timeout = setTimeout(stop, 60 * 60_000);
  timeout.unref();
  child.stderr?.resume();
  child.stdout?.on("data", (block: Buffer) => {
    if (output.length + block.length > options.outputLimit) {
      invalid = true;
      void owner.stop().catch(() => undefined);
    } else output = Buffer.concat([output, block]);
  });
  child.once("exit", (code) => {
    exit = code;
  });
  child.stdin?.on("error", () => {
    invalid = true;
  });
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) stop();
    await owner.ready;
    if (!cancelled) {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(frame.length);
      await new Promise<void>((resolve, reject) => {
        if (!child.stdin) return reject(options.refused());
        child.stdin.write(header);
        child.stdin.write(frame, (error) => (error ? reject(options.refused()) : resolve()));
      });
    }
    await owner.joined;
    if (cancelled || signal.aborted)
      throw new DOMException("The data operation was cancelled", "AbortError");
    if (invalid) throw options.refused();
    let reply: unknown;
    try {
      reply = JSON.parse(output.toString("utf8"));
    } catch {
      throw options.refused();
    }
    if (
      reply &&
      typeof reply === "object" &&
      "version" in reply &&
      reply.version === 1 &&
      "ok" in reply &&
      reply.ok === false &&
      "error" in reply &&
      reply.error &&
      typeof reply.error === "object" &&
      "code" in reply.error
    ) {
      const failure = options.failure?.(reply.error.code);
      if (failure) throw failure;
    }
    if (exit !== 0) throw options.refused();
    if (
      !reply ||
      typeof reply !== "object" ||
      !("version" in reply) ||
      reply.version !== 1 ||
      !("ok" in reply) ||
      reply.ok !== true ||
      !("result" in reply)
    )
      throw options.refused();
    return reply.result;
  } finally {
    frame.fill(0);
    output.fill(0);
    clearTimeout(timeout);
    signal.removeEventListener("abort", stop);
    if (!owner.joinedConfirmed) await owner.stop();
    child.stdin?.destroy();
  }
}
