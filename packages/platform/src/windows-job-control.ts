// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmdirSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

const MAX_FRAME_BYTES = 512;
const MAX_CONNECTIONS = 16;
const CLIENT_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 1_000;

export interface WindowsJobControlConfiguration {
  pipe: string;
  cookie: string;
  /** Exact FILETIME of the verified original Node owner. */
  parentBirth: string;
  deadlineUnixMs: number;
}

function controlError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Windows job control ${code}`), { code });
}

/** Authenticated cancellation and completion, independent of the target's raw stdin. */
export class WindowsJobControl {
  readonly configuration: WindowsJobControlConfiguration;
  readonly endpoint: string;
  readonly listening: Promise<void>;
  readonly closed: Promise<void>;
  readonly failed: Promise<never>;
  private readonly server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
  private readonly sockets = new Set<Socket>();
  private readonly directory: string | undefined;
  private resolveListening!: () => void;
  private rejectListening!: (error: Error) => void;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: Error) => void;
  private rejectFailure!: (error: Error) => void;
  private child: ChildProcess | undefined;
  private rawKill: ChildProcess["kill"] | undefined;
  private authenticated: Socket | undefined;
  private targetAllowed = false;
  private joined = false;
  private stopping = false;
  private started = false;
  private rawClosed = false;
  private finalizing = false;
  private finalized = false;
  private failure: Error | undefined;
  private setupTimer: NodeJS.Timeout | undefined;
  private forceTimer: NodeJS.Timeout | undefined;
  private releaseInput: () => Promise<void> = () => Promise.resolve();

  constructor(parentBirth: string, deadlineUnixMs = Date.now() + 30_000) {
    if (
      !/^[0-9]{1,19}$/u.test(parentBirth) ||
      BigInt(parentBirth) <= 0n ||
      BigInt(parentBirth) > 9223372036854775807n ||
      !Number.isSafeInteger(deadlineUnixMs)
    )
      throw controlError("invalid-owner");
    const pipe = `omnesis-job-${process.pid}-${randomBytes(24).toString("hex")}`;
    this.configuration = {
      pipe,
      cookie: randomBytes(32).toString("hex"),
      parentBirth,
      deadlineUnixMs,
    };
    this.directory = process.platform === "win32" ? undefined : mkdtempSync(join(tmpdir(), "oj-"));
    this.endpoint = this.directory ? join(this.directory, "control.sock") : `\\\\.\\pipe\\${pipe}`;
    this.listening = new Promise<void>((resolve, reject) => {
      this.resolveListening = resolve;
      this.rejectListening = reject;
    });
    this.closed = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    this.failed = new Promise<never>((_, reject) => {
      this.rejectFailure = reject;
    });
    void this.failed.catch(() => {});
    // Streaming consumers may observe readiness/exit without awaiting cleanup.
    void this.listening.catch(() => {});
    void this.closed.catch(() => {});
    this.server.once("listening", () => {
      this.server.unref();
      this.resolveListening();
      if (this.finalized) this.server.close(() => {});
    });
    this.server.on("error", () => {
      const error = controlError("listener-failed");
      this.rejectListening(error);
      this.fail(error);
    });
  }

  /** Call before spawning the helper; configuration is gated on listening. */
  start(): void {
    if (this.started || this.finalizing) throw controlError("already-started");
    this.started = true;
    const remaining = this.configuration.deadlineUnixMs - Date.now();
    if (remaining <= 0) {
      const error = controlError("ETIMEDOUT");
      this.rejectListening(error);
      this.fail(error);
      throw error;
    }
    this.setupTimer = setTimeout(() => this.fail(controlError("ETIMEDOUT")), remaining);
    this.setupTimer.unref();
    this.server.listen(this.endpoint);
  }

  /** The retained process handle is installed before publication or configuration. */
  attach(child: ChildProcess, releaseInput: () => Promise<void>): void {
    if (this.child) throw controlError("already-attached");
    this.child = child;
    this.releaseInput = releaseInput;
    this.rawKill = child.kill.bind(child);
    child.kill = (signal = "SIGTERM") => {
      if (signal === 0) return this.rawKill!(0);
      if (
        typeof signal === "string"
          ? !Object.hasOwn(constants.signals, signal.toUpperCase())
          : !Object.values(constants.signals).includes(signal)
      )
        throw Object.assign(new TypeError("Unknown process signal"), {
          code: "ERR_UNKNOWN_SIGNAL",
        });
      return this.stop();
    };
    child.once("close", () => {
      this.rawClosed = true;
      void this.finalize();
    });
    if (this.stopping || this.failure) this.rawKill("SIGKILL");
  }

  get inputAllowed(): boolean {
    return !this.stopping && !this.failure && !this.rawClosed;
  }

  /** Status0 still comes from native target creation, independently of control ACK. */
  targetStarted(): void {
    if (!this.targetAllowed) {
      const error = controlError("unauthenticated-start");
      this.fail(error);
      throw error;
    }
    clearTimeout(this.setupTimer);
  }

  /** Idempotent cancellation; only native JOINED can confirm a live target drained. */
  stop(): boolean {
    if (this.rawClosed) return false;
    if (this.stopping) return true;
    this.stopping = true;
    if (!this.targetAllowed) {
      // No ACK has permitted CreateProcess, so there is no payload to drain.
      this.rawKill?.("SIGKILL");
      return true;
    }
    if (this.joined) return true;
    this.authenticated?.write(Buffer.from([1]), (error) => {
      if (error) this.fail(controlError("cancel-write-failed"));
    });
    this.forceTimer = setTimeout(() => {
      this.failure ??= controlError("unjoined-fallback");
      this.rawKill?.("SIGKILL");
    }, CLEANUP_TIMEOUT_MS);
    this.forceTimer.unref();
    return true;
  }

  /** Dispose after a synchronous spawn/configuration failure; no target was permitted. */
  abandon(): void {
    this.stopping = true;
    if (this.child) this.rawKill?.("SIGKILL");
    else {
      this.rawClosed = true;
      void this.finalize();
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.rejectFailure(this.failure);
    this.stop();
  }

  private accept(socket: Socket): void {
    socket.unref();
    if (this.finalizing || this.sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(
      () => socket.destroy(),
      Math.max(1, Math.min(CLIENT_TIMEOUT_MS, this.configuration.deadlineUnixMs - Date.now())),
    );
    timer.unref();
    socket.on("error", () => {
      if (socket === this.authenticated && !this.rawClosed)
        this.fail(controlError("connection-failed"));
    });
    socket.once("end", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
      if (socket === this.authenticated && !this.joined && !this.rawClosed)
        this.fail(controlError("completion-missing"));
    });
    socket.on("data", (chunk: Buffer) => {
      if (socket === this.authenticated) {
        if (chunk.length !== 1 || chunk[0] !== 2 || this.joined) {
          this.fail(controlError("invalid-completion"));
          return;
        }
        this.joined = true;
        clearTimeout(this.forceTimer);
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        socket.destroy();
        return;
      }
      if (
        end !== bytes.length - 1 ||
        this.authenticated ||
        !this.child?.pid ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "cookie,pid"
      ) {
        socket.destroy();
        return;
      }
      const record = value as Record<string, unknown>;
      if (
        record.pid !== this.child.pid ||
        typeof record.cookie !== "string" ||
        !/^[0-9a-f]{64}$/u.test(record.cookie) ||
        !timingSafeEqual(
          Buffer.from(record.cookie, "hex"),
          Buffer.from(this.configuration.cookie, "hex"),
        )
      ) {
        socket.destroy();
        return;
      }
      clearTimeout(timer);
      if (this.stopping || this.failure || this.rawClosed) {
        socket.destroy();
        return;
      }
      this.authenticated = socket;
      this.targetAllowed = true;
      // Native verifies this server's PID and retained parent birth before
      // disclosing its cookie; this ACK alone permits payload creation.
      socket.write(Buffer.from([0]), (error) => {
        if (error) this.fail(controlError("ack-write-failed"));
      });
    });
  }

  private async finalize(): Promise<void> {
    if (this.finalizing) return;
    this.finalizing = true;
    clearTimeout(this.setupTimer);
    clearTimeout(this.forceTimer);
    const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
    const bounded = async (operation: Promise<void>): Promise<void> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(controlError("unjoined-cleanup")),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    let serverClosed: Promise<void> | undefined;
    try {
      // Keep cleanup alive after the last retained child handle closes.
      this.server.ref();
      if (this.started) await bounded(this.listening.catch(() => {}));
      for (const socket of this.sockets) if (socket !== this.authenticated) socket.destroy();
      if (this.server.listening)
        serverClosed = new Promise<void>((resolve, reject) =>
          this.server.close((error) => (error ? reject(error) : resolve())),
        );
      const authenticated = this.authenticated;
      if (authenticated && !authenticated.closed) {
        authenticated.ref();
        // A final JOINED byte can be dispatched after ChildProcess rawclose.
        await bounded(new Promise<void>((resolve) => authenticated.once("close", () => resolve())));
      }
      await bounded(this.releaseInput());
    } catch {
      this.failure ??= controlError("unjoined-cleanup");
    } finally {
      for (const socket of this.sockets) socket.destroy();
      try {
        if (!serverClosed && this.server.listening)
          serverClosed = new Promise<void>((resolve, reject) =>
            this.server.close((error) => (error ? reject(error) : resolve())),
          );
        if (serverClosed) await bounded(serverClosed);
        if (this.directory) rmdirSync(this.directory);
      } catch {
        this.failure ??= controlError("unjoined-cleanup");
      }
      this.finalized = true;
    }
    if (this.failure) this.rejectClosed(this.failure);
    else if (this.targetAllowed && !this.joined)
      this.rejectClosed(controlError("completion-missing"));
    else this.resolveClosed();
  }
}
