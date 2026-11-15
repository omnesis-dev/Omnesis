// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
/** Windows Job ownership with a real Node IPC child; POSIX keeps native groups. */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PassThrough, type Readable } from "node:stream";
import {
  spawnWindowsJob,
  requestChildShutdown,
  ownedProcessCleanupReceipt,
  type WindowsJobProcess,
  assertNever,
} from "@omnesis/core";
import { e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { E2EControlDecoder, encodeE2EInput, type E2EControl } from "./e2e-process-protocol.js";

interface ApplicationExit {
  code: number | null;
  signal: string | null;
}
type StopOptions = { initialSignal?: NodeJS.Signals; termGraceMs?: number; killGraceMs?: number };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function cleanupError(reasons: unknown[]): Error {
  const marked = reasons.find((error) => ownedProcessCleanupReceipt(error) !== undefined);
  const receipt = ownedProcessCleanupReceipt(marked);
  return Object.assign(
    new AggregateError(reasons, "E2E owned process cleanup was not confirmed", {
      cause: marked ?? reasons[0],
    }),
    { cleanupFailure: receipt !== undefined ? receipt.failure : reasons[0] },
  );
}
async function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ complete: true; value: T } | { complete: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then((value) => ({ complete: true as const, value })),
      new Promise<{ complete: false }>((resolve) => {
        timer = setTimeout(() => resolve({ complete: false }), Math.max(1, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const owned = new WeakMap<ChildProcess, OwnedE2EProcess>();
export class OwnedE2EProcess {
  readonly stderr = new PassThrough();
  readonly rawClosed: Promise<ApplicationExit>;
  readonly joined: Promise<void>;
  readonly ready: Promise<void>;
  private appPid: number | undefined;
  private appExit: ApplicationExit | undefined;
  private confirmed = false;
  get applicationPid(): number | undefined {
    return this.appPid;
  }
  get applicationExit(): ApplicationExit | undefined {
    return this.appExit;
  }
  get joinConfirmed(): boolean {
    return this.confirmed;
  }
  private readonly spawned = deferred<void>();
  private readonly acknowledgement = deferred<boolean>();
  private readonly decoder: E2EControlDecoder;
  private failurePresent = false;
  private failure: unknown;
  private cancelRequested = false;
  private expectedCancellation = false;
  private explicitAbrupt = false;
  private shutdownAccepted = false;
  private shutdownRequested = false;
  private acknowledgementSeen = false;
  private shutdown?: Promise<boolean>;
  private stopping?: Promise<void>;
  private readonly cancellationErrors: unknown[] = [];
  private readonly cleanupFailures: unknown[] = [];
  private readonly publication = deferred<void>();
  private readonly controlPublications: Promise<void>[] = [];
  private rawEnded = false;
  constructor(
    readonly raw: WindowsJobProcess,
    private readonly nonce: string,
    deadline: number,
    initialFrame: Buffer,
  ) {
    this.decoder = new E2EControlDecoder(
      nonce,
      (bytes) => {
        if (!this.stderr.write(bytes)) raw.stderr.pause();
      },
      (frame) => this.receive(frame),
    );
    this.stderr.on("drain", () => raw.stderr.resume());
    raw.stderr.on("data", (bytes: Buffer) => {
      try {
        this.decoder.write(bytes);
      } catch (error) {
        this.fail(error);
        this.cancelOwnedJob();
      }
    });
    const outputError = (error: unknown): void => {
      this.fail(error);
      this.cancelOwnedJob();
    };
    raw.stdout.on("error", outputError);
    raw.stderr.on("error", outputError);
    this.stderr.on("error", outputError);
    raw.on("error", (error) => {
      if (!this.expectedCancellation || ownedProcessCleanupReceipt(error) !== undefined)
        this.fail(error);
    });
    raw.stdin.on("error", (error) => {
      this.rememberCleanupFailure(error);
      this.acknowledgement.resolve(false);
    });
    this.rawClosed = new Promise((resolve) =>
      raw.once("close", (code, signal) => {
        this.rawEnded = true;
        try {
          this.decoder.end(this.cancelRequested);
        } catch (error) {
          this.fail(error);
        }
        if (!this.applicationExit && !this.cancelRequested)
          this.fail(Error("Missing E2E application close receipt"));
        this.stderr.end();
        this.spawned.reject(Error("E2E wrapper closed before target creation"));
        this.acknowledgement.resolve(false);
        resolve({ code, signal });
      }),
    );
    this.ready = (async () => {
      const preparation = Promise.all([raw.jobReady, this.spawned.promise]);
      void preparation.catch(() => {});
      if (performance.now() >= deadline)
        throw Error("E2E target preparation exceeded the shared boot budget");
      const result = await within(preparation, deadline - performance.now());
      if (!result.complete || performance.now() >= deadline)
        throw Error("E2E target preparation exceeded the shared boot budget");
    })();
    const preparationObserved = this.ready.catch((error) => {
      if (!this.expectedCancellation || ownedProcessCleanupReceipt(error) !== undefined)
        this.fail(error);
      this.cancelOwnedJob();
    });
    const nativePreparationObserved = raw.jobReady.catch((error) => {
      this.rememberCleanupFailure(error);
    });
    this.joined = Promise.allSettled([
      this.rawClosed,
      raw.jobClosed,
      preparationObserved,
      nativePreparationObserved,
      this.publication.promise,
    ]).then(async (results) => {
      await Promise.all(this.controlPublications);
      const rejected = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason as unknown);
      if (rejected.length || this.cleanupFailures.length)
        throw cleanupError([...rejected, ...this.cleanupFailures]);
      this.confirmed = true;
    });
    void this.joined.catch(() => {});
    if (performance.now() >= deadline) {
      this.fail(Error("E2E target preparation exceeded the shared boot budget"));
      this.cancelOwnedJob();
      this.publication.resolve();
    } else this.publish(initialFrame);
  }
  private publish(frame: Buffer): void {
    try {
      this.raw.stdin.write(frame, (error) => {
        if (error) {
          if (!this.expectedCancellation || ownedProcessCleanupReceipt(error) !== undefined)
            this.fail(error);
          this.cancelOwnedJob();
        }
        this.publication.resolve();
      });
    } catch (error) {
      this.fail(error);
      this.cancelOwnedJob();
      this.publication.resolve();
    }
  }
  private fail(error: unknown): void {
    this.rememberCleanupFailure(error);
    if (!this.failurePresent) {
      this.failurePresent = true;
      this.failure = error;
    }
    this.spawned.reject(error);
    this.acknowledgement.resolve(false);
  }
  private rememberCleanupFailure(error: unknown): void {
    if (ownedProcessCleanupReceipt(error) !== undefined) this.cleanupFailures.push(error);
  }
  private receive(frame: E2EControl): void {
    switch (frame.type) {
      case "spawned":
        if (this.applicationExit !== undefined || this.applicationPid !== undefined)
          throw Error("Duplicate E2E target creation receipt");
        this.appPid = frame.pid;
        this.spawned.resolve();
        break;
      case "shutdown-ack":
        if (!this.shutdownRequested || this.acknowledgementSeen)
          throw Error("Unexpected E2E shutdown acknowledgement");
        this.acknowledgementSeen = true;
        this.shutdownAccepted = frame.accepted;
        this.acknowledgement.resolve(frame.accepted);
        break;
      case "closed":
        if (this.applicationExit !== undefined) throw Error("Duplicate E2E target close receipt");
        this.appExit = { code: frame.code, signal: frame.signal };
        break;
      case "failed":
        if (!this.expectedCancellation) this.fail(Error("E2E wrapper " + frame.code + " failed"));
        this.cancelOwnedJob();
        break;
      default:
        assertNever(frame);
    }
  }
  requestShutdown(): Promise<boolean> {
    if (this.shutdown) return this.shutdown;
    this.shutdown = (async () => {
      await this.ready;
      if (this.applicationExit || this.rawEnded) return false;
      this.shutdownRequested = true;
      const publication = deferred<void>();
      this.controlPublications.push(publication.promise);
      try {
        this.raw.stdin.write(
          encodeE2EInput({ type: "shutdown", version: 1, nonce: this.nonce }),
          (error) => {
            if (error) {
              this.rememberCleanupFailure(error);
              this.acknowledgement.resolve(false);
            }
            publication.resolve();
          },
        );
      } catch (error) {
        this.rememberCleanupFailure(error);
        this.acknowledgement.resolve(false);
        publication.resolve();
      }
      const receipt = await within(this.acknowledgement.promise, 5000);
      return receipt.complete && receipt.value;
    })();
    return this.shutdown;
  }
  /** Hard cancellation is never presented as a graceful IPC acknowledgement. */
  cancel(): void {
    this.explicitAbrupt = true;
    this.expectedCancellation = true;
    this.cancelOwnedJob();
  }
  private cancelOwnedJob(): void {
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    try {
      this.raw.kill("SIGKILL");
    } catch (error) {
      this.cancellationErrors.push(error);
      this.rememberCleanupFailure(error);
    }
  }
  stop(options: StopOptions = {}): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.terminate(options);
    return this.stopping;
  }
  private async terminate(options: StopOptions): Promise<void> {
    if (!this.joinConfirmed) {
      if (options.initialSignal !== "SIGKILL") {
        const graceful = this.requestShutdown().then(() => this.joined);
        void graceful.catch(() => {});
        const closed = await within(graceful, options.termGraceMs ?? 5000).catch(() => ({
          complete: false as const,
        }));
        if (!closed.complete) {
          this.expectedCancellation = true;
          this.cancelOwnedJob();
        }
      } else this.cancel();
      const closed = await within(this.joined, options.killGraceMs ?? 2000);
      if (!closed.complete)
        throw Object.assign(
          cleanupError([Error("E2E owned Job did not confirm cleanup within its teardown budget")]),
          { cleanupPending: true },
        );
    }
    const marked = this.cancellationErrors.filter(
      (error) => ownedProcessCleanupReceipt(error) !== undefined,
    );
    if (marked.length) throw cleanupError(marked);
    if (this.cancellationErrors.length)
      throw new AggregateError(
        [...(this.failurePresent ? [this.failure] : []), ...this.cancellationErrors],
        "E2E cancellation failed after confirmed cleanup",
        { cause: this.cancellationErrors[0] },
      );
    if (this.failurePresent) throw this.failure;
    if (
      !this.applicationExit &&
      !this.explicitAbrupt &&
      (!this.cancelRequested || !this.shutdownAccepted)
    )
      throw Error("Missing E2E application close receipt or acknowledged shutdown bridge");
  }
  status(): { exitCode: number | null; signalCode: string | null } {
    if (this.failurePresent) throw this.failure;
    return {
      exitCode: this.applicationExit?.code ?? null,
      signalCode: this.applicationExit?.signal ?? null,
    };
  }
}

export function createE2ESubprocessSpawner(
  deps: { platform?: NodeJS.Platform; spawnOwned?: typeof spawnWindowsJob } = {},
) {
  return (command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess => {
    if ((deps.platform ?? process.platform) !== "win32") return spawn(command, [...args], options);
    const deadline = performance.now() + gatewayBootBudgetMs();
    const wrapper = fileURLToPath(new URL("./e2e-node-wrapper.mjs", import.meta.url));
    const invocation = e2eTsxCommand(wrapper),
      nonce = randomBytes(32).toString("hex");
    const frame = encodeE2EInput({ type: "launch", version: 1, nonce, command, args: [...args] });
    const raw = (deps.spawnOwned ?? spawnWindowsJob)(invocation.command, invocation.args, {
      cwd:
        options.cwd === undefined
          ? undefined
          : typeof options.cwd === "string"
            ? options.cwd
            : fileURLToPath(options.cwd),
      env: options.env,
      completion: "tree",
    });
    const record = new OwnedE2EProcess(raw, nonce, deadline, frame);
    owned.set(raw, record);
    if (Array.isArray(options.stdio) && options.stdio[1] === "ignore") raw.stdout.resume();
    if (Array.isArray(options.stdio) && options.stdio[2] === "ignore") record.stderr.resume();
    return raw;
  };
}
export const spawnE2ESubprocess = createE2ESubprocessSpawner();
export function getOwnedE2EProcess(proc: ChildProcess): OwnedE2EProcess | undefined {
  return owned.get(proc);
}
export function e2eApplicationPid(proc: ChildProcess): number | undefined {
  const record = owned.get(proc);
  return record ? record.applicationPid : proc.pid;
}
export function e2eApplicationStatus(proc: ChildProcess): {
  exitCode: number | null;
  signalCode: string | null;
} {
  return owned.get(proc)?.status() ?? { exitCode: proc.exitCode, signalCode: proc.signalCode };
}
export function e2eProcessOutput(proc: ChildProcess): {
  stdout: Readable | null;
  stderr: Readable | null;
} {
  return { stdout: proc.stdout, stderr: owned.get(proc)?.stderr ?? proc.stderr };
}
export function requestE2EProcessShutdown(proc: ChildProcess): Promise<boolean> {
  return owned.get(proc)?.requestShutdown() ?? requestChildShutdown(proc);
}
export async function e2eProcessExit(proc: ChildProcess): Promise<number | null> {
  const record = owned.get(proc);
  if (record) {
    await record.joined;
    return record.status().exitCode;
  }
  if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
  return new Promise((resolve) => proc.once("close", (code) => resolve(code)));
}
