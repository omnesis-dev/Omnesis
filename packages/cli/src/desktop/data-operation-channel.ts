// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { serialize } from "node:v8";
import { managedDesktopDataOperationInvocation, spawnOwnedChildProcess } from "@omnesis/core";
import { desktopEnvironment, type DesktopProfile } from "./environment.js";
import { desktopRestoreFailureFromCode } from "./restore-errors.js";

export type DesktopDataPurpose =
  "erase" | "restore" | "rollback" | "update-snapshot" | "update-rollback";
export interface DesktopDataRequest {
  version: 1;
  purpose: DesktopDataPurpose;
  operationId: string;
  profile: DesktopProfile;
  payload: unknown;
}
import { DESKTOP_DATA_INPUT_LIMIT } from "./data-operation-frame.js";
const OUTPUT_LIMIT = 64 * 1024;
const refused = () =>
  new Error(
    "The protected data operation did not finish. Review its recovery status before retrying.",
  );

/** The native executable fixes the host entry; no caller-selected module is executed. */
export async function runDesktopDataOperation(
  request: DesktopDataRequest,
  signal: AbortSignal,
  dependencies: {
    invocation?: typeof managedDesktopDataOperationInvocation;
    spawn?: typeof spawnOwnedChildProcess;
  } = {},
): Promise<unknown> {
  signal.throwIfAborted();
  const frame = serialize(request);
  if (frame.length > DESKTOP_DATA_INPUT_LIMIT) {
    frame.fill(0);
    throw refused();
  }
  let owner: ReturnType<typeof spawnOwnedChildProcess>;
  try {
    const invocation = (dependencies.invocation ?? managedDesktopDataOperationInvocation)(
      request.profile,
      request.purpose,
      request.operationId,
    );
    owner = (dependencies.spawn ?? spawnOwnedChildProcess)(invocation.command, invocation.args, {
      env: desktopEnvironment(request.profile),
    });
  } catch {
    frame.fill(0);
    throw refused();
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
    if (output.length + block.length > OUTPUT_LIMIT) {
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
        if (!child.stdin) return reject(refused());
        child.stdin.write(header);
        child.stdin.write(frame, (error) => (error ? reject(refused()) : resolve()));
      });
    }
    await owner.joined;
    if (cancelled || signal.aborted)
      throw new DOMException("The data operation was cancelled", "AbortError");
    if (invalid) throw refused();
    let reply: unknown;
    try {
      reply = JSON.parse(output.toString("utf8"));
    } catch {
      throw refused();
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
      const failure = desktopRestoreFailureFromCode(reply.error.code);
      if (failure) throw failure;
    }
    if (exit !== 0) throw refused();
    if (
      !reply ||
      typeof reply !== "object" ||
      !("version" in reply) ||
      reply.version !== 1 ||
      !("ok" in reply) ||
      reply.ok !== true ||
      !("result" in reply)
    )
      throw refused();
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
