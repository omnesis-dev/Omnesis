// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import {
  managedRuntimeExecutableInvocation,
  managedRuntimeSubprocessStdio,
} from "./node-command.js";

// Node uses a socketpair for child.stdin. OpenSSL's /dev/stdin loader needs a
// real pipe. This fixed pipeline supplies one without files or secret argv.
const PIPELINE = '/bin/cat | /usr/bin/openssl "$@"';
const MAX_INPUT_BYTES = 131_072;

/** Sign with an in-memory key; await the owned pipeline before releasing files. */
export async function runOpenSslWithPrivateInput(
  args: readonly string[],
  privateInput: Uint8Array,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (
    process.platform === "win32" ||
    privateInput.byteLength === 0 ||
    privateInput.byteLength > MAX_INPUT_BYTES ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000
  )
    throw new Error("Private certificate input is unsupported or outside its bounds");
  const env = { ...process.env };
  // No shell startup hooks or alternate OpenSSL providers may observe key input.
  for (const name of Object.keys(env)) {
    if (
      ["ENV", "BASH_ENV"].includes(name) ||
      name.startsWith("OPENSSL_") ||
      name.startsWith("BASH_FUNC_") ||
      name.startsWith("LD_") ||
      name.startsWith("DYLD_")
    )
      delete env[name];
  }
  const invocation = managedRuntimeExecutableInvocation("/bin/sh", [
    "-c",
    PIPELINE,
    "omnesis-cert-pipe",
    ...args,
  ]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env,
      detached: true,
      stdio: managedRuntimeSubprocessStdio(["pipe", "ignore", "ignore"]),
    });
    let failure = false;
    let closed = false;
    let settled = false;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      options.signal?.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolve();
    };
    const stop = (): void => {
      if (closed) return;
      failure = true;
      if (child.pid !== undefined) {
        try {
          // This PID belongs to the detached child just spawned above; no
          // persisted PID, process search or unrelated cohort is consulted.
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Keep awaiting physical close even if signalling was refused.
          // The bounded cleanup timer below records an unconfirmed join.
        }
      }
      cleanupTimer ??= setTimeout(() => {
        finish(
          Object.assign(new Error("Certificate process cleanup is unconfirmed"), {
            cleanupFailure: "certificate-pipeline",
          }),
        );
      }, 5_000);
    };
    const timer = setTimeout(stop, timeoutMs);
    options.signal?.addEventListener("abort", stop, { once: true });
    child.once("error", () => {
      failure = true;
    });
    child.once("close", (code, signal) => {
      closed = true;
      finish(
        failure || code !== 0 || signal !== null
          ? new Error("Private certificate generation failed or was cancelled")
          : undefined,
      );
    });
    // EPIPE is an ordinary rejected input, reported through pipeline completion.
    child.stdin!.on("error", () => {});
    child.stdin!.end(privateInput);
    if (options.signal?.aborted) stop();
  });
}
