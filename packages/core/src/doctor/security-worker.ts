// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Retained ownership of the host security audit and its Native-capable worker. */

import { Worker } from "node:worker_threads";
import { resolveWorkerEntry } from "../worker-entry.js";
import { ownedProcessCleanupReceipt } from "../owned-process-cleanup.js";
import type { SecurityData } from "./types.js";
import type {
  DoctorSecurityWorkerInput,
  DoctorSecurityWorkerMessage,
} from "./security-worker-protocol.js";

export const SECURITY_SCAN_TIMEOUT_MS = 30_000;
export interface CollectSecurityDataInWorkerOptions {
  configDir: string;
  component?: "gateway" | "collector";
  timeoutMs?: number;
}
export interface DoctorSecurityScannerOptions extends CollectSecurityDataInWorkerOptions {
  /** Synchronous ownership notification; called before a worker can start. */
  onOwnershipChanged?: () => void;
}
interface Scan {
  result: Promise<SecurityData>;
  joined: Promise<void>;
}

/** Observation deadlines never authorize terminating a thread's owned processes. */
export class DoctorSecurityScanner {
  private current: Scan | undefined;
  private closed = false;
  private held = false;
  private terminal: unknown;
  private closing: Promise<void> | undefined;
  private readonly pending = Object.assign(new Error("Security posture worker remains active"), {
    cleanupFailure: undefined,
    cleanupPending: true as const,
  });
  constructor(private readonly options: DoctorSecurityScannerOptions) {}

  cleanupFailure(): unknown | undefined {
    return this.held ? this.terminal : this.current ? this.pending : undefined;
  }
  private notify(): { error: unknown } | undefined {
    try {
      this.options.onOwnershipChanged?.();
    } catch (error) {
      return { error };
    }
    return undefined;
  }
  private hold(error: unknown): void {
    if (this.held) return;
    this.held = true;
    this.terminal = error;
    this.notify();
  }

  collect(): Promise<SecurityData> {
    if (this.held) return Promise.reject(this.terminal);
    if (this.closed) return Promise.reject(new Error("Security posture scanner is closed"));
    if (this.current) return this.current.result;
    const timeoutMs = this.options.timeoutMs ?? SECURITY_SCAN_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new Error("Security scan timeout must be a positive finite number"));
    const deadline = performance.now() + timeoutMs;
    const deadlineError = () => new Error(`Security posture scan timed out after ${timeoutMs}ms`);
    let resolveResult!: (value: SecurityData) => void, rejectResult!: (error: unknown) => void;
    let resolveJoin!: () => void, rejectJoin!: (error: unknown) => void;
    const result = new Promise<SecurityData>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const joined = new Promise<void>((resolve, reject) => {
      resolveJoin = resolve;
      rejectJoin = reject;
    });
    void joined.catch(() => {});
    const scan = { result, joined };
    this.current = scan;
    const notificationError = this.notify();
    if (notificationError !== undefined || this.closed) {
      this.current = undefined;
      resolveJoin();
      rejectResult(
        notificationError
          ? notificationError.error
          : new Error("Security posture scanner is closed"),
      );
      this.notify();
      return result;
    }
    let worker: Worker;
    try {
      const entry = resolveWorkerEntry(
        "./security-worker-entry.ts",
        import.meta.url,
        "./register-tsx.mjs",
      );
      const input: DoctorSecurityWorkerInput = {
        configDir: this.options.configDir,
        component: this.options.component ?? "gateway",
      };
      if (performance.now() >= deadline) throw deadlineError();
      worker = new Worker(entry.url, { workerData: input, execArgv: entry.execArgv });
    } catch (error) {
      this.current = undefined;
      resolveJoin();
      this.notify();
      rejectResult(error);
      return result;
    }
    let observationSettled = false;
    let completion: { security: SecurityData } | { error: Error } | undefined;
    const rejectObservation = (error: unknown): void => {
      if (observationSettled) return;
      observationSettled = true;
      rejectResult(error);
    };
    const unconfirmed = (cause: unknown): void => {
      const error = Object.assign(
        new Error("Security posture worker cleanup could not be confirmed", { cause }),
        {
          cleanupFailure: undefined,
        },
      );
      this.hold(error);
      rejectObservation(error);
    };
    const observeDeadline = (): void => {
      if (performance.now() >= deadline) rejectObservation(deadlineError());
    };
    const remainingMs = Math.max(0, deadline - performance.now());
    const timer = setTimeout(() => {
      rejectObservation(deadlineError());
    }, remainingMs);
    timer.unref();
    observeDeadline();
    // Keep the worker referenced: isolate/parent death is not Native child join.
    worker.on("message", (message: DoctorSecurityWorkerMessage) => {
      observeDeadline();
      if (completion) {
        unconfirmed(new Error("Security posture worker returned duplicate completion"));
        return;
      }
      if (
        message?.type === "done" &&
        message.security &&
        typeof message.security === "object" &&
        !Object.hasOwn(message, "cleanupFailure")
      ) {
        completion = { security: message.security };
      } else if (message?.type === "error" && typeof message.error === "string") {
        const error = new Error(message.error);
        completion = { error };
        if (Object.hasOwn(message, "cleanupFailure")) {
          Object.assign(error, { cleanupFailure: message.cleanupFailure });
          this.hold(error);
          rejectObservation(error);
        }
      } else unconfirmed(new Error("Security posture worker returned an invalid completion"));
    });
    worker.on("error", (error) => {
      observeDeadline();
      unconfirmed(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      observeDeadline();
      if (code !== 0 || !completion)
        unconfirmed(new Error(`Security posture worker exited without clean completion (${code})`));
      this.current = undefined;
      this.notify();
      if (this.held) {
        rejectObservation(this.terminal);
        rejectJoin(this.terminal);
      } else {
        resolveJoin();
        if (!observationSettled) {
          observationSettled = true;
          if (completion && "security" in completion) resolveResult(completion.security);
          else if (completion && "error" in completion) rejectResult(completion.error);
        }
      }
    });
    return result;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.current?.joined;
      if (this.held) throw this.terminal;
    })();
    return this.closing;
  }
}

/** Standalone callers retain the scanner until join, even after an observation timeout. */
export async function collectSecurityDataInWorker(
  opts: CollectSecurityDataInWorkerOptions,
): Promise<SecurityData> {
  const scanner = new DoctorSecurityScanner(opts);
  let failed = false,
    failure: unknown,
    security: SecurityData | undefined;
  try {
    security = await scanner.collect();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await scanner.close();
  } catch (error) {
    if (!failed || error === failure) throw error;
    const receipt = ownedProcessCleanupReceipt(error);
    const combined = new AggregateError([failure, error], "Security scan and cleanup failed", {
      cause: receipt ? error : failure,
    });
    if (receipt) Object.assign(combined, { cleanupFailure: receipt.failure });
    throw combined;
  }
  if (failed) throw failure;
  return security!;
}
