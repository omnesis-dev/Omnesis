// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { createLogger, resolveSubprocessEntry, spawnOwnedChildProcess } from "@omnesis/core";
import { FrameDecoder, type WhisperWorkerMessage } from "./whisper-worker-protocol.js";

const log = createLogger("gateway:transcribe:whisper");

/** A worker's logical exit and independently confirmed process/cohort closure. */
export interface WhisperWorkerProcess {
  write(frame: Buffer): void;
  /** Immediately request SIGKILL, then join the actual process/cohort. */
  kill(): Promise<void>;
  readonly joined: Promise<void>;
  readonly joinedConfirmed: boolean;
  onMessage(handler: (msg: WhisperWorkerMessage) => void): void;
  onExit(
    handler: (info: { code: number | null; signal: string | null; error?: Error }) => void,
  ): void;
}
export interface SpawnWhisperWorkerArgs {
  modelPath: string;
  gpu: boolean;
  offloadSeconds: number;
}
export type WhisperWorkerSpawner = (args: SpawnWhisperWorkerArgs) => WhisperWorkerProcess;

const workerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z
    .object({
      type: z.literal("result"),
      id: z.number().int().positive(),
      text: z.string(),
      language: z.string().optional(),
      durationSec: z.number().finite().nonnegative().optional(),
      segments: z
        .array(
          z
            .object({
              startMs: z.number().finite().nonnegative(),
              endMs: z.number().finite().nonnegative(),
              text: z.string(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("error"), id: z.number().int().positive(), error: z.string() })
    .strict(),
]);

/** Frame the same owned subprocess under source and compiled entrypoints. */
export const defaultWhisperSpawner: WhisperWorkerSpawner = (args) => {
  const entry = resolveSubprocessEntry("./whisper-worker.ts", import.meta.url);
  const owner = spawnOwnedChildProcess(
    entry.command,
    [...entry.args, args.modelPath, args.gpu ? "1" : "0", String(args.offloadSeconds)],
    { cwd: import.meta.dirname, env: process.env, stopSignal: "SIGKILL" },
  );
  const proc = owner.child;
  let onMessage: ((msg: WhisperWorkerMessage) => void) | undefined;
  let onExit:
    ((info: { code: number | null; signal: string | null; error?: Error }) => void) | undefined;
  let failed = false;
  const failure = (error: unknown) => {
    const requestStop = !failed;
    failed = true;
    const cause =
      error instanceof Error
        ? error
        : new Error("Whisper worker transport failed", { cause: error });
    onExit?.({ code: null, signal: null, error: cause });
    if (requestStop)
      void owner.stop().catch((stopError: unknown) => {
        onExit?.({
          code: null,
          signal: null,
          error:
            stopError instanceof Error
              ? stopError
              : new Error("Whisper worker stop failed", { cause: stopError }),
        });
      });
  };
  const decoder = new FrameDecoder(
    (header) => {
      const parsed = workerMessage.safeParse(header);
      if (!parsed.success) throw new Error("Invalid Whisper worker response");
      onMessage?.(parsed.data);
    },
    { maxTailBytes: 0 },
  );
  proc.stdout?.on("data", (chunk: Buffer) => {
    if (failed) return;
    try {
      decoder.push(chunk);
    } catch (error) {
      failure(error);
    }
  });
  proc.stdout?.on("error", failure);
  proc.stdin?.on("error", failure);
  proc.stderr?.on("error", failure);
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    const trimmed = chunk.trimEnd();
    if (trimmed) log.debug(`worker: ${trimmed}`);
  });
  proc.on("exit", (code, signal) => onExit?.({ code, signal }));
  proc.on("error", failure);
  void owner.ready.catch(failure);
  void owner.joined.catch(failure);
  return {
    write: (frame) => {
      if (!proc.stdin?.writable) throw new Error("Whisper worker input is closed");
      proc.stdin.write(frame);
    },
    kill: () => owner.stop(),
    joined: owner.joined,
    get joinedConfirmed() {
      return owner.joinedConfirmed;
    },
    onMessage: (handler) => {
      onMessage = handler;
    },
    onExit: (handler) => {
      onExit = handler;
    },
  };
};
