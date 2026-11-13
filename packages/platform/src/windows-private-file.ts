// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { runWindowsJob, runWindowsJobSync, type WindowsJobResult } from "./windows-job.js";
import { windowsPowerShellExecutable } from "./windows-powershell.js";
import { WINDOWS_PRIVATE_FILE_POWERSHELL_SCRIPT as SCRIPT } from "./native/windows-private-file-source.js";

const MAX_BYTES = 16_384;
const COMMIT = Buffer.from("\0OMNESIS_PRIVATE_COMMIT_V1\0", "ascii");

// Security descriptors are inspected on the open handle, not on a second path
// lookup. CreateNew applies the protected DACL before any private bytes exist.

export interface WindowsPrivateExactNames {
  exactBasename?: string;
  exactParentBasename?: string;
}
export interface WindowsPrivatePath {
  path: string;
  kind: "file" | "directory";
}
export interface WindowsPrivatePathStatus {
  private: boolean;
  fixed: boolean;
  error?: "EPRIVATE";
}
type Operation =
  | {
      action: "create" | "atomic";
      path: string;
      length: number;
      readOnly: boolean;
      staging?: string;
      receipt?: boolean;
      replaceExisting?: boolean;
    }
  | { action: "cleanup"; path: string; identity: string }
  | ({ action: "read"; path: string; limit: number } & WindowsPrivateExactNames)
  | ({ action: "delete"; path: string } & WindowsPrivateExactNames)
  | { action: "inspect"; paths: readonly WindowsPrivatePath[]; repair: boolean; protect?: boolean };

let program: string | undefined;
function encodedProgram(): string {
  if (program !== undefined) return program;
  // Only this constant public program is decompressed in memory. The reader
  // never touches stdin, whose metadata and secret bytes use exact native reads.
  const source = gzipSync(Buffer.from(SCRIPT, "utf8")).toString("base64");
  const bootstrap = `$memory=[IO.MemoryStream]::new([Convert]::FromBase64String('${source}'),$false);$gzip=[IO.Compression.GZipStream]::new($memory,[IO.Compression.CompressionMode]::Decompress);$reader=[IO.StreamReader]::new($gzip,[Text.Encoding]::UTF8);try { & ([scriptblock]::Create($reader.ReadToEnd())) } finally { $reader.Dispose();$memory.Dispose() }`;
  program = Buffer.from(bootstrap, "utf16le").toString("base64");
  return program;
}

function invocation(
  operation: Operation,
  input?: Uint8Array,
  complete = true,
): { command: string; args: string[]; input: Buffer } {
  const paths =
    operation.action === "inspect" ? operation.paths.map((entry) => entry.path) : [operation.path];
  if (paths.length > 5000 || paths.some((path) => path.includes("\0")))
    throw new Error("Invalid private file path");
  const metadata = Buffer.from(JSON.stringify(operation), "utf8");
  if (metadata.length > 2097152) throw new Error("Private file operation is too large");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(metadata.length);
  const command = windowsPowerShellExecutable();
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedProgram()];
  // The native Job launcher quotes each argument, including the executable.
  if (command.length + 3 + args.reduce((size, arg) => size + arg.length + 3, 0) > 32767) {
    throw new Error("Windows private helper command line is too large");
  }
  const commit =
    complete && (operation.action === "create" || operation.action === "atomic")
      ? COMMIT
      : Buffer.alloc(0);
  return {
    command,
    args,
    input: Buffer.concat([length, metadata, Buffer.from(input ?? []), commit]),
  };
}
function resultBytes(result: WindowsJobResult): Buffer {
  if (result.failure || result.exitCode !== 0) {
    const last = result.stderr.trim().split(/\r?\n/u).at(-1) ?? "";
    const diagnostic = /^(ENOENT|EEXIST|EPRIVATE)(?::([a-z-]+):([0-9]+))?$/u.exec(last);
    const code = diagnostic?.[1] ?? "EPRIVATE";
    const stage = diagnostic?.[2];
    const nativeCode = diagnostic?.[3] === undefined ? undefined : Number(diagnostic[3]);
    const failure = Object.assign(
      new Error(
        "Private file must be a bounded private regular file with a trusted Windows owner and ACL" +
          (stage === undefined ? "" : ` (${stage}; native error ${nativeCode})`),
      ),
      {
        code,
        ...(stage === undefined ? {} : { stage, nativeCode }),
        ...(result.failure ? { failure: result.failure } : {}),
      },
    );
    const cleanup = /^OMNESIS_PRIVATE_CLEANUP_FAILED:([0-9]+)\r?$/mu.exec(result.stderr);
    if (cleanup) {
      throw new AggregateError(
        [
          failure,
          Object.assign(new Error("Private staging cleanup failed"), {
            code: "EPRIVATE",
            stage: "cleanup",
            nativeCode: Number(cleanup[1]),
          }),
        ],
        "Private write failed and staging cleanup failed",
      );
    }
    throw failure;
  }
  return Buffer.from(result.stdout);
}
async function operate(operation: Operation, input?: Uint8Array): Promise<Buffer> {
  const run = invocation(operation, input);
  return resultBytes(
    await runWindowsJob(run.command, run.args, { input: run.input, timeoutMs: 30_000 }),
  );
}
function operateSync(operation: Operation, input?: Uint8Array): Buffer {
  const run = invocation(operation, input);
  return resultBytes(
    runWindowsJobSync(run.command, run.args, {
      input: run.input,
      timeoutMs: 30_000,
      maxBuffer: Number.MAX_SAFE_INTEGER,
    }),
  );
}
/** Read a bounded regular file through the handle whose owner and DACL are verified. */
export function readWindowsPrivateFile(path: string, limit = MAX_BYTES): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 16 * 1024 * 1024)
    throw new Error("Invalid private file read bound");
  return operate({ action: "read", path, limit });
}
/** Capture a whole protected file like readFile, without the authority-key size cap. */
export function readWindowsPrivateFileContents(
  path: string,
  opts: WindowsPrivateExactNames = {},
): Promise<Buffer> {
  return operate({
    action: "read",
    path,
    limit: -1,
    exactBasename: opts.exactBasename,
    exactParentBasename: opts.exactParentBasename,
  });
}
export function readWindowsPrivateFileContentsSync(
  path: string,
  opts: WindowsPrivateExactNames = {},
): Buffer {
  return operateSync({
    action: "read",
    path,
    limit: -1,
    exactBasename: opts.exactBasename,
    exactParentBasename: opts.exactParentBasename,
  });
}
/** Remove only the verified exact legacy key/namespace, through its held handle. */
export async function deleteWindowsPrivateFileExact(
  path: string,
  opts: WindowsPrivateExactNames,
): Promise<void> {
  if (!opts.exactBasename && !opts.exactParentBasename)
    throw new Error("An exact private file name is required");
  await operate({
    action: "delete",
    path,
    exactBasename: opts.exactBasename,
    exactParentBasename: opts.exactParentBasename,
  });
}
export function deleteWindowsPrivateFileExactSync(
  path: string,
  opts: WindowsPrivateExactNames,
): void {
  if (!opts.exactBasename && !opts.exactParentBasename)
    throw new Error("An exact private file name is required");
  operateSync({
    action: "delete",
    path,
    exactBasename: opts.exactBasename,
    exactParentBasename: opts.exactParentBasename,
  });
}
/** Create a new file with a private DACL atomically, before writing secret bytes. */
export async function createWindowsPrivateFile(
  path: string,
  bytes: Uint8Array,
  opts: { readOnly?: boolean } = {},
): Promise<void> {
  await operate(
    { action: "create", path, length: bytes.byteLength, readOnly: opts.readOnly === true },
    bytes,
  );
}
export function createWindowsPrivateFileSync(
  path: string,
  bytes: Uint8Array,
  opts: { readOnly?: boolean } = {},
): void {
  operateSync(
    { action: "create", path, length: bytes.byteLength, readOnly: opts.readOnly === true },
    bytes,
  );
}
/** Publish the flushed private file through its held handle, under a pinned safe parent. */
export async function writeWindowsPrivateFileAtomic(
  path: string,
  bytes: Uint8Array,
  opts: { readOnly?: boolean } = {},
): Promise<void> {
  await operate(
    { action: "atomic", path, length: bytes.byteLength, readOnly: opts.readOnly === true },
    bytes,
  );
}
export function writeWindowsPrivateFileAtomicSync(
  path: string,
  bytes: Uint8Array,
  opts: { readOnly?: boolean } = {},
): void {
  operateSync(
    { action: "atomic", path, length: bytes.byteLength, readOnly: opts.readOnly === true },
    bytes,
  );
}
function statuses(bytes: Buffer, count: number): WindowsPrivatePathStatus[] {
  const values: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !Array.isArray(values) ||
    values.length !== count ||
    values.some(
      (value: unknown) =>
        typeof value !== "object" ||
        value === null ||
        !("private" in value) ||
        typeof value.private !== "boolean" ||
        !("fixed" in value) ||
        typeof value.fixed !== "boolean" ||
        ("error" in value && value.error !== "EPRIVATE"),
    )
  ) {
    throw new Error("Invalid private file inspection result");
  }
  return values as WindowsPrivatePathStatus[];
}
export async function inspectWindowsPrivatePaths(
  paths: readonly WindowsPrivatePath[],
  opts: { repair?: boolean; protect?: boolean } = {},
): Promise<WindowsPrivatePathStatus[]> {
  if (paths.length === 0) return [];
  return statuses(
    await operate({
      action: "inspect",
      paths,
      repair: opts.repair === true,
      protect: opts.protect,
    }),
    paths.length,
  );
}
export function inspectWindowsPrivatePathSync(
  path: string,
  kind: WindowsPrivatePath["kind"],
): WindowsPrivatePathStatus {
  return statuses(
    operateSync({ action: "inspect", paths: [{ path, kind }], repair: false }),
    1,
  )[0]!;
}
export function secureWindowsPrivatePathSync(path: string, kind: WindowsPrivatePath["kind"]): void {
  const result = statuses(
    operateSync({ action: "inspect", paths: [{ path, kind }], repair: true, protect: true }),
    1,
  )[0]!;
  if (!result.private)
    throw new Error("Private path requires a trusted Windows owner and safe ACL");
}

/** Commit plaintext only after successful source completion (including authentication). */
export async function writeWindowsPrivateFileAtomicStream(
  path: string,
  source: Readable,
  declaredLength: number,
  opts: {
    readOnly?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    replaceExisting?: boolean;
  } = {},
): Promise<void> {
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
    throw new Error("Invalid private file length");
  const staging = win32.basename(path) + ".omnesis-" + process.pid + "-" + randomUUID() + ".tmp";
  const scratch = win32.join(win32.dirname(path), staging);
  const run = invocation(
    {
      action: "atomic",
      path,
      length: declaredLength,
      readOnly: opts.readOnly === true,
      staging,
      receipt: true,
      replaceExisting: opts.replaceExisting,
    },
    undefined,
    false,
  );
  let sourceFailed = false,
    sourceError: unknown,
    stopped = false,
    completed = false;
  let receipt: string | undefined,
    stderr = "";
  const observeError = (error: unknown): void => {
    if (!stopped && !sourceFailed && !opts.signal?.aborted) {
      sourceFailed = true;
      sourceError = error;
    }
  };
  source.on("error", observeError);
  const input = Readable.from(
    (async function* () {
      yield run.input;
      let written = 0;
      try {
        for await (const value of source as AsyncIterable<unknown>) {
          if (!(value instanceof Uint8Array) && typeof value !== "string")
            throw new Error("Invalid private file input chunk");
          const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
          written += bytes.length;
          if (written > declaredLength) throw new Error("Private file input length mismatch");
          yield bytes;
        }
        if (written !== declaredLength) throw new Error("Private file input length mismatch");
        if (sourceFailed) throw sourceError;
        // A GCM source reaches here only after its final authentication succeeds.
        yield COMMIT;
      } catch (error) {
        observeError(error);
        throw error;
      }
    })(),
  );
  input.on("error", observeError);
  let failed = false,
    failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const result = await runWindowsJob(run.command, run.args, {
      inputStream: input,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onStderr(bytes) {
        stderr += Buffer.from(bytes).toString("utf8");
        const lines = stderr.split("\n");
        stderr = lines.pop()!.slice(-4096);
        for (const line of lines) {
          const match = /^OMNESIS_PRIVATE_CREATED:([0-9]+:[0-9]+:-?[0-9]+)\r?$/u.exec(line);
          if (match) receipt = match[1];
        }
      },
    });
    if (sourceFailed) throw sourceError;
    opts.signal?.throwIfAborted();
    resultBytes(result);
    completed = true;
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    stopped = true;
    try {
      input.destroy();
      // _destroy may report its own error asynchronously after an early helper
      // failure, before iteration ever attached a stream error handler.
      if (source.closed) source.removeListener("error", observeError);
      else source.once("close", () => source.removeListener("error", observeError));
      if (!source.destroyed) source.destroy();
    } catch (error) {
      cleanupErrors.push(error);
    }
    // No receipt means CREATE_NEW may have collided: never unlink by guess.
    // Cleanup verifies the receipt on its own held handle before deleting it.
    if (!completed && receipt) {
      try {
        await operate({ action: "cleanup", path: scratch, identity: receipt });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length > 0) {
    if (failed)
      throw new AggregateError(
        [failure, ...cleanupErrors],
        "Private write failed and staging cleanup failed",
      );
    throw new AggregateError(cleanupErrors, "Private staging cleanup failed");
  }
  if (failed) throw failure;
}
