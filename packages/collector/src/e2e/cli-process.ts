// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Keep process outcome evidence without logging credentials, arguments or output. */
export async function execCliWithDiagnostics(
  command: string,
  args: string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const started = performance.now();
  try {
    return await execFileAsync(command, args, { ...options, encoding: "utf8" });
  } catch (error) {
    const details =
      error !== null && typeof error === "object"
        ? (error as {
            code?: unknown;
            killed?: unknown;
            signal?: unknown;
            stdout?: unknown;
            stderr?: unknown;
          })
        : {};
    const code =
      typeof details.code === "number" ||
      (typeof details.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(details.code))
        ? details.code
        : "unknown";
    const signal =
      typeof details.signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(details.signal)
        ? details.signal
        : "none";
    const bytes = (value: unknown): number =>
      typeof value === "string" || Buffer.isBuffer(value) ? Buffer.byteLength(value) : 0;
    // Process errors retain command arguments and captured output; omit that unsafe cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `CLI subprocess failed after ${Math.round(performance.now() - started)}ms: code=${code}, signal=${signal}, killed=${details.killed === true}, stdoutBytes=${bytes(details.stdout)}, stderrBytes=${bytes(details.stderr)}`,
    );
  }
}
