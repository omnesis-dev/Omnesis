// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { win32 } from "node:path";
import {
  windowsPowerShellExecutable,
  windowsProcessStart,
  windowsEnvironmentValue,
} from "./windows-powershell.js";
import { WINDOWS_CACHE_BOOTSTRAP_SCRIPT } from "./native/windows-cache-bootstrap-source.js";
import {
  WINDOWS_WORKER_CONFIG,
  WINDOWS_WORKER_MANIFEST,
  WINDOWS_WORKER_SOURCE,
} from "./native/windows-worker-source.js";
import type { WindowsJobResult, WindowsOwnedInvocation } from "./windows-owned-process.js";

const COMMIT = Buffer.from("\0OMNESIS_PRIVATE_COMMIT_V1\0", "ascii");
const sourceHash = createHash("sha256")
  .update(
    WINDOWS_WORKER_SOURCE + "\0" + WINDOWS_WORKER_CONFIG + "\0" + WINDOWS_WORKER_MANIFEST + "\0v1",
  )
  .digest("hex");
let verifiedExecutable: string | undefined;
let initializationFailed = false;
let initializationFailure: unknown;
// Product dotenv and target environments never redirect the host helper cache.
const hostProfile = windowsEnvironmentValue("USERPROFILE");
const hostLocalAppData =
  windowsEnvironmentValue("LOCALAPPDATA") ??
  (hostProfile ? win32.join(hostProfile, "AppData", "Local") : undefined);

// Reads only the bounded constant PUBLIC bootstrap program, leaving the native
// metadata/source frame at the exact current stdin offset. No buffered reader.
const LOAD_PROGRAM = String.raw`
$ErrorActionPreference='Stop'
try {
  $inputStream=[Console]::OpenStandardInput()
  function ReadExact([int]$count) {
    $bytes=[byte[]]::new($count)
    $offset=0
    while ($offset -lt $count) {
      $read=$inputStream.Read($bytes,$offset,$count-$offset)
      if ($read -eq 0) { throw 'Incomplete native bootstrap' }
      $offset+=$read
    }
    return ,$bytes
  }
  $count=[BitConverter]::ToUInt32((ReadExact 4),0)
  if ($count -eq 0 -or $count -gt 1048576) { throw 'Invalid native bootstrap length' }
  $program=[Text.UTF8Encoding]::new($false,$true).GetString((ReadExact $count))
  & ([scriptblock]::Create($program))
} catch { [Console]::Error.Write('EPRIVATE');exit 1 }
`;

export interface WindowsBootstrapRequest {
  invocation: WindowsOwnedInvocation;
  input: Uint8Array;
}
export type WindowsBootstrapRunner = (request: WindowsBootstrapRequest) => WindowsJobResult;
function frame(bytes: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}
function cacheRoot(): string {
  const local = hostLocalAppData;
  if (
    !local ||
    !win32.isAbsolute(local) ||
    win32.parse(local).root.length <= 1 ||
    local.includes("\0")
  ) {
    throw new Error("Windows local application directory is unavailable");
  }
  return win32.join(local, "Omnesis", "platform-native-v1");
}

/** Validate or compile one protected generation using the uncached trusted runner. */
export function windowsWorkerInvocation(
  mode: "job" | "filesystem",
  bootstrap: WindowsBootstrapRunner,
  opts: { timeoutMs?: number } = {},
): WindowsOwnedInvocation {
  if (initializationFailed) throw initializationFailure;
  if (verifiedExecutable === undefined) {
    try {
      const root = cacheRoot();
      // Original Node receives these UTC ticks while still alive, before any
      // nested bootstrap can start. Normalize year-1 .NET ticks to FILETIME's
      // 1601 epoch with exact integers, never Date/Number rounding.
      const ticks = windowsProcessStart(process.pid, opts.timeoutMs);
      if (ticks === null || BigInt(ticks) <= 116444736000000000n)
        throw new Error("Cannot verify Windows native worker owner");
      const ownerBirth = (BigInt(ticks) - 116444736000000000n).toString();
      const program = Buffer.from(WINDOWS_CACHE_BOOTSTRAP_SCRIPT, "utf8");
      const source = Buffer.from(WINDOWS_WORKER_SOURCE, "utf8");
      if (program.length > 1048576 || source.length > 1048576)
        throw new Error("Windows native source is too large");
      const metadata = Buffer.from(
        JSON.stringify({
          root,
          sourceHash,
          ownerPid: process.pid,
          ownerBirth,
          length: source.length,
          runtimeConfig: WINDOWS_WORKER_CONFIG,
          manifest: WINDOWS_WORKER_MANIFEST,
        }),
        "utf8",
      );
      const result = bootstrap({
        invocation: {
          command: windowsPowerShellExecutable(),
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(LOAD_PROGRAM, "utf16le").toString("base64"),
          ],
        },
        input: Buffer.concat([frame(program), frame(metadata), source, COMMIT]),
      });
      if (result.failure || result.exitCode !== 0 || result.stdout.length > 65536) {
        throw new Error("Cannot initialize the protected Windows native worker");
      }
      let record: unknown;
      try {
        record = JSON.parse(Buffer.from(result.stdout).toString("utf8"));
      } catch {
        throw new Error("Invalid Windows native worker verification response");
      }
      const expected = win32.join(root, sourceHash, "worker.exe");
      if (
        !record ||
        typeof record !== "object" ||
        !("executable" in record) ||
        record.executable !== expected ||
        !("sourceHash" in record) ||
        record.sourceHash !== sourceHash ||
        !("binaryHash" in record) ||
        typeof record.binaryHash !== "string" ||
        !/^[0-9a-f]{64}$/u.test(record.binaryHash) ||
        !("ownerPid" in record) ||
        record.ownerPid !== process.pid ||
        !("ownerBirth" in record) ||
        record.ownerBirth !== ownerBirth ||
        !("pinsTransferred" in record) ||
        record.pinsTransferred !== true
      ) {
        throw new Error("Invalid Windows native worker verification response");
      }
      // The uncached bootstrap checked owner, protected DACL, reparse metadata,
      // source generation and binary hash before returning this executable.
      verifiedExecutable = expected;
    } catch (error) {
      // A failed/truncated reply may follow successful handle transfer. Never
      // repeat initialization and accumulate ambiguous retained handles.
      initializationFailed = true;
      initializationFailure = error;
      throw error;
    }
  }
  return {
    command: verifiedExecutable,
    args: mode === "job" ? ["job"] : ["filesystem", String(process.pid)],
  };
}
