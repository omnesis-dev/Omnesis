// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  spawnOwnedChildProcess,
  ownedProcessCleanupReceipt,
  type OwnedChildProcess,
} from "@omnesis/core";
import { z } from "zod";

const PREFIX = "OMNESIS_TAILNET_FIXTURE ";
const MAX_FRAME_BYTES = 64 * 1024;
const replySchema = z.union([
  z.object({ id: z.number().int().nonnegative(), value: z.unknown() }).strict(),
  z.object({ id: z.number().int().positive(), error: z.string().min(1).max(4096) }).strict(),
]);
const bootstrapSchema = z.object({ controlUrl: z.string().url() }).strict();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

async function bounded<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Strict framing for an owned test actor, independent of pipe chunk boundaries. */
export class TailnetActorFrames {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private pendingBytes = 0;
  constructor(
    private readonly receive: (frame: unknown) => void,
    private readonly log: (line: string) => void,
  ) {}
  write(bytes: Uint8Array): void {
    this.consume(this.decoder.decode(bytes, { stream: true }));
  }
  end(): void {
    this.consume(this.decoder.decode());
    if (this.pending) throw new Error("Incomplete tailnet actor output frame");
  }
  private consume(text: string): void {
    for (;;) {
      const end = text.indexOf("\n");
      const part = end < 0 ? text : text.slice(0, end);
      this.pendingBytes += Buffer.byteLength(part);
      if (this.pendingBytes > MAX_FRAME_BYTES)
        throw new Error("Tailnet actor output exceeds its frame bound");
      this.pending += part;
      if (end < 0) return;
      const line = this.pending.replace(/\r$/u, "");
      this.pending = "";
      this.pendingBytes = 0;
      if (line.startsWith(PREFIX)) this.receive(JSON.parse(line.slice(PREFIX.length)) as unknown);
      else this.log(line);
      text = text.slice(end + 1);
    }
  }
}

/** The fixture owns this complete Go process before any peer can be created. */
export class PortableTailnetActor {
  private readonly owner: OwnedChildProcess;
  private bootSeen = false;
  private readonly bootstrap = deferred<string>();
  private readonly closed = deferred<number | null>();
  private readonly pending = new Map<number, ReturnType<typeof deferred<unknown>>>();
  private readonly cleanupErrors: unknown[] = [];
  private nextId = 1;
  private ended = false;
  private failurePresent = false;
  private failure: unknown;
  private cancellationStarted = false;
  private output = "";
  private stopping?: Promise<void>;
  readonly ready: Promise<string>;

  constructor(
    executable: string,
    directory: string,
    cliDirectory: string,
    cwd: string,
    dependencies: { spawnActor?: typeof spawnOwnedChildProcess } = {},
  ) {
    this.owner = (dependencies.spawnActor ?? spawnOwnedChildProcess)(
      executable,
      ["-test.run=^TestTailnetFixtureActor$", "-test.timeout=30m"],
      {
        cwd,
        env: {
          ...process.env,
          OMNESIS_TEST_TAILNET_ROOT: directory,
          PORTABLE_TAILSCALE_CLI_DIR: cliDirectory,
        },
      },
    );
    const child = this.owner.child;
    const frames = new TailnetActorFrames(
      (frame) => this.receive(frame),
      (line) => {
        this.output = `${this.output}${line}\n`.slice(-8192);
      },
    );
    child.stdout!.on("data", (bytes: Buffer) => {
      if (this.failurePresent) return;
      try {
        frames.write(bytes);
      } catch (error) {
        this.fail(error);
        this.cancel();
      }
    });
    child.stderr!.on("data", (bytes: Buffer) => {
      this.output = `${this.output}${bytes.toString()}`.slice(-8192);
    });
    child.stdin!.on("error", (error) => this.fail(error));
    child.stdout!.on("error", (error) => {
      this.fail(error);
      this.cancel();
    });
    child.stderr!.on("error", (error) => {
      this.fail(error);
      this.cancel();
    });
    child.on("error", (error) => this.fail(error));
    child.once("close", (code) => {
      this.ended = true;
      try {
        frames.end();
      } catch (error) {
        this.fail(error);
      }
      const error = new Error(`Tailnet fixture actor closed (${code})`);
      if (code !== 0) this.fail(error);
      else this.rejectPending(error);
      this.closed.resolve(code);
    });
    void this.owner.ready.catch((error) => this.fail(error));
    void this.owner.joined.catch((error) => this.fail(error));
    this.ready = bounded(
      Promise.all([this.owner.ready, this.bootstrap.promise]).then(([, url]) => url),
      60_000,
      "Tailnet fixture actor did not prepare",
    );
    void this.ready.catch((error) => {
      this.fail(error);
      this.cancel();
    });
  }

  logs(): string {
    return this.output;
  }

  async request(
    operation: string,
    input: Record<string, unknown> = {},
    timeoutMs = 90_000,
  ): Promise<unknown> {
    await this.ready;
    if (this.ended || this.pending.size >= 16)
      throw new Error("Tailnet fixture actor cannot accept a request");
    const id = this.nextId++;
    const frame = Buffer.from(`${JSON.stringify({ ...input, id, op: operation })}\n`);
    if (frame.length > MAX_FRAME_BYTES)
      throw new Error("Tailnet actor request exceeds its frame bound");
    const result = deferred<unknown>();
    this.pending.set(id, result);
    try {
      this.owner.child.stdin!.write(frame, (error) => {
        if (error) result.reject(error);
      });
      return await bounded(result.promise, timeoutMs, "Tailnet fixture operation did not finish");
    } finally {
      this.pending.delete(id);
    }
  }

  private receive(value: unknown): void {
    const reply = replySchema.parse(value);
    if (reply.id === 0) {
      if ("error" in reply || this.bootSeen) throw new Error("Invalid fixture bootstrap");
      this.bootSeen = true;
      const { controlUrl } = bootstrapSchema.parse(reply.value);
      const url = new URL(controlUrl);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.pathname !== "/" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Tailnet fixture control escaped loopback");
      this.bootstrap.resolve(controlUrl);
      return;
    }
    const pending = this.pending.get(reply.id);
    if (!pending) throw new Error("Unexpected tailnet actor response");
    this.pending.delete(reply.id);
    if ("error" in reply) pending.reject(new Error(reply.error));
    else if (Object.hasOwn(reply, "value")) pending.resolve(reply.value);
    else throw new Error("Missing tailnet actor response value");
  }

  private fail(error: unknown): void {
    if (ownedProcessCleanupReceipt(error) !== undefined) this.cleanupErrors.push(error);
    if (!this.failurePresent) {
      this.failurePresent = true;
      this.failure = error;
    }
    this.rejectPending(error);
  }

  private rejectPending(error: unknown): void {
    this.bootstrap.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
  }

  private cancel(): void {
    if (this.cancellationStarted) return;
    this.cancellationStarted = true;
    void this.owner.stop().catch((error) => {
      this.cleanupErrors.push(error);
      this.fail(error);
    });
  }

  stop(): Promise<void> {
    return (this.stopping ??= this.close());
  }

  private async close(): Promise<void> {
    let operationFailed = false;
    let operationError: unknown;
    try {
      if (!this.ended) await this.request("stop", {}, 10_000);
      const [, code] = await bounded(
        Promise.all([this.owner.joined, this.closed.promise]),
        15_000,
        "Tailnet fixture closure is unconfirmed",
      );
      if (code !== 0) throw new Error(`Tailnet fixture exited unsuccessfully (${code})`);
    } catch (error) {
      operationFailed = true;
      operationError = error;
      const results = await Promise.allSettled([
        bounded(this.owner.stop(), 15_000, "Tailnet fixture cancellation is unconfirmed"),
        bounded(this.closed.promise, 15_000, "Tailnet fixture output closure is unconfirmed"),
      ]);
      for (const result of results)
        if (result.status === "rejected") this.cleanupErrors.push(result.reason as unknown);
    }
    if (!this.owner.joinedConfirmed || this.cleanupErrors.length) {
      const marked = this.cleanupErrors
        .map(ownedProcessCleanupReceipt)
        .find((receipt) => receipt !== undefined);
      throw Object.assign(
        new AggregateError(this.cleanupErrors, "Tailnet fixture cleanup is unconfirmed", {
          cause: operationError,
        }),
        { cleanupFailure: marked ? marked.failure : this.cleanupErrors[0] },
      );
    }
    if (this.failurePresent) throw this.failure;
    if (operationFailed) throw operationError;
  }
}
