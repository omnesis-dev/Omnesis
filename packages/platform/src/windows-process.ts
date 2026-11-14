// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { windowsFilesystemInvocation } from "./windows-job.js";
import {
  runWindowsOwnedProcess,
  runWindowsOwnedProcessSync,
  type WindowsJobResult,
} from "./windows-owned-process.js";

export interface WindowsNativeProcessIdentity {
  pid: number;
  parentPid: number;
  /** Exact UTC .NET ticks, including the final 100 ns digit. */
  birth: string;
}
const TIMEOUT_MS = 10_000;
const MAX_REQUESTS = 8192;
type Operation =
  | { action: "process-snapshot"; roots: readonly number[] }
  | {
      action: "process-kill";
      targets: readonly Pick<WindowsNativeProcessIdentity, "pid" | "birth">[];
    };
function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff;
}
function invocation(operation: Operation) {
  const entries = operation.action === "process-snapshot" ? operation.roots : operation.targets;
  if (entries.length > MAX_REQUESTS) throw new Error("Too many owned Windows process identities");
  if (operation.action === "process-snapshot") {
    if (!operation.roots.every(validPid)) throw new Error("Invalid owned Windows process PID");
  } else if (
    !operation.targets.every(
      ({ pid, birth }) =>
        validPid(pid) && /^[0-9]{1,19}$/u.test(birth) && BigInt(birth) <= 9223372036854775807n,
    )
  )
    throw new Error("Invalid owned Windows process identity");
  const start = Date.now();
  const metadata = Buffer.from(
    JSON.stringify(
      operation.action === "process-snapshot"
        ? { action: operation.action, roots: operation.roots }
        : {
            action: operation.action,
            targets: operation.targets.map(({ pid, birth }) => ({ pid, birth })),
          },
    ),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32LE(metadata.length);
  const native = windowsFilesystemInvocation(TIMEOUT_MS);
  const timeoutMs = TIMEOUT_MS - (Date.now() - start);
  if (timeoutMs <= 0) throw new Error("Owned Windows process operation timed out");
  return { ...native, input: Buffer.concat([length, metadata]), timeoutMs };
}
function bytes(result: WindowsJobResult): Buffer {
  if (result.failure || result.exitCode !== 0) {
    const code =
      /EPRIVATE:process-(?:snapshot|kill):[0-9]+/u.exec(result.stderr)?.[0] ??
      result.failure ??
      "failed";
    throw new Error(`Owned Windows process operation ${code}`);
  }
  if (result.stdout.length > 4 * 1024 * 1024)
    throw new Error("Windows process snapshot exceeded its limit");
  return Buffer.from(result.stdout);
}
function rows(output: Buffer): WindowsNativeProcessIdentity[] {
  const data: unknown = JSON.parse(output.toString("utf8"));
  if (!Array.isArray(data) || data.length > 65536)
    throw new Error("Invalid Windows process snapshot");
  return data.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid Windows process identity");
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !== "birth,parentPid,pid" ||
      !validPid(Number(row.pid)) ||
      typeof row.pid !== "number" ||
      typeof row.parentPid !== "number" ||
      !Number.isSafeInteger(row.parentPid) ||
      row.parentPid < 0 ||
      row.parentPid > 0xffffffff ||
      typeof row.birth !== "string" ||
      !/^[0-9]{1,19}$/u.test(row.birth) ||
      BigInt(row.birth) > 9223372036854775807n
    )
      throw new Error("Invalid Windows process identity");
    return { pid: row.pid, parentPid: row.parentPid, birth: row.birth };
  });
}
export async function snapshotWindowsProcesses(
  roots: readonly number[],
): Promise<WindowsNativeProcessIdentity[]> {
  if (roots.length === 0) return [];
  const call = invocation({ action: "process-snapshot", roots });
  return rows(bytes(await runWindowsOwnedProcess(call, call.input, { timeoutMs: call.timeoutMs })));
}
export function snapshotWindowsProcessesSync(
  roots: readonly number[],
): WindowsNativeProcessIdentity[] {
  if (roots.length === 0) return [];
  const call = invocation({ action: "process-snapshot", roots });
  return rows(
    bytes(
      runWindowsOwnedProcessSync(call, call.input, {
        timeoutMs: call.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      }),
    ),
  );
}
export async function killWindowsProcesses(
  targets: readonly Pick<WindowsNativeProcessIdentity, "pid" | "birth">[],
): Promise<void> {
  if (targets.length === 0) return;
  const call = invocation({ action: "process-kill", targets });
  bytes(await runWindowsOwnedProcess(call, call.input, { timeoutMs: call.timeoutMs }));
}
export function killWindowsProcessesSync(
  targets: readonly Pick<WindowsNativeProcessIdentity, "pid" | "birth">[],
): void {
  if (targets.length === 0) return;
  const call = invocation({ action: "process-kill", targets });
  bytes(
    runWindowsOwnedProcessSync(call, call.input, { timeoutMs: call.timeoutMs, maxBuffer: 65536 }),
  );
}
