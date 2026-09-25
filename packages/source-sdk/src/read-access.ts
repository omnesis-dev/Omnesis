// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { closeSync, constants, fstat, open, type Dirent } from "node:fs";
import { opendir } from "node:fs/promises";
import type { SyncRemediation } from "@omnesis/types";
import type { SourceReadAccessResult } from "./define-source.js";

export interface ReadAccessOptions {
  signal: AbortSignal;
  /** Provider-owned remedy. Callers must not put paths in display strings. */
  remediation?: SyncRemediation;
}

type Failure = { status: "denied" | "unavailable"; remediation?: SyncRemediation };

/** Maximum entries examined in one directory; overflow is unavailable. */
const MAX_READ_ACCESS_DIRECTORY_ENTRIES = 256;

function failure(error: unknown, options: ReadAccessOptions): Failure {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (!options.signal.aborted && (code === "EACCES" || code === "EPERM")) {
    return {
      status: "denied",
      ...(options.remediation ? { remediation: options.remediation } : {}),
    };
  }
  return { status: "unavailable" };
}

/**
 * Keep ownership until late handles close. The doctor's deadline bounds the
 * caller's wait and fences overlapping probes while this promise is pending.
 */
async function cancellable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  const result = await work();
  return signal.aborted ? undefined : result;
}

/**
 * Fresh open only: never reads content, uses cached handles, or creates a file.
 * Opening and inspecting the descriptor are asynchronous. Closing is deliberately
 * on the JS thread: a libuv-thread close can release this process's POSIX locks
 * concurrently with an eager SQLite statement on the same inode. Main-thread
 * close runs between those statements, including authentication/metadata reads.
 * This is suitable only for eager same-thread SQLite readers: a provider holding
 * a transaction/iterator across await, or accessing the inode from another
 * thread, must coordinate its readers instead of using this helper unguarded.
 */
export async function probeFileReadAccess(
  path: string,
  options: ReadAccessOptions,
): Promise<SourceReadAccessResult> {
  return (
    (await cancellable(async () => {
      try {
        // NONBLOCK prevents a mistakenly configured FIFO from hanging the daemon.
        // Raw fd, not FileHandle: there must be no asynchronous finalizer close.
        const fd = await new Promise<number>((resolve, reject) => {
          open(path, constants.O_RDONLY | constants.O_NONBLOCK, (error, descriptor) => {
            if (error) reject(error);
            else resolve(descriptor);
          });
        });
        try {
          if (options.signal.aborted) return { status: "unavailable" } as const;
          const isFile = await new Promise<boolean>((resolve, reject) => {
            fstat(fd, (error, stat) => {
              if (error) reject(error);
              else resolve(stat.isFile());
            });
          });
          return {
            status: !options.signal.aborted && isFile ? "readable" : "unavailable",
          } as const;
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        return failure(error, options);
      }
    }, options.signal)) ?? { status: "unavailable" }
  );
}

/**
 * Bounded provider-owned discovery. Entries stay inside the provider; never
 * serialize them into doctor output. Overflow is unknown, not partial success.
 */
export async function listReadAccessDirectory(
  path: string,
  options: ReadAccessOptions,
): Promise<{ status: "readable"; entries: Dirent[] } | Failure> {
  return (
    (await cancellable(async () => {
      try {
        const directory = await opendir(path);
        try {
          const entries: Dirent[] = [];
          while (!options.signal.aborted) {
            const entry = await directory.read();
            if (options.signal.aborted) return { status: "unavailable" } as const;
            if (!entry) return { status: "readable", entries } as const;
            if (entries.length === MAX_READ_ACCESS_DIRECTORY_ENTRIES)
              return { status: "unavailable" } as const;
            entries.push(entry);
          }
          return { status: "unavailable" } as const;
        } finally {
          await directory.close();
        }
      } catch (error) {
        return failure(error, options);
      }
    }, options.signal)) ?? { status: "unavailable" }
  );
}
