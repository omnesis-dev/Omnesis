// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Readable, Writable } from "node:stream";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING = 32;
const MAX_SESSION_REQUESTS = 65536;
const requestSchema = z
  .object({
    version: z.literal(1).default(1),
    id: z.string().min(1).max(128),
    command: z.enum([
      "status",
      "prepare",
      "connect",
      "stop",
      "restart",
      "openPortal",
      "respond",
      "cancel",
      "removePreview",
      "remove",
      "recoveryImport",
      "recoveryStatus",
      "recoveryPrepare",
      "recoveryCommit",
      "recoveryCancel",
      "updateStatus",
      "updateCheck",
      "updateDownload",
      "updatePrepareCurrent",
      "updateInstall",
      "updateResume",
      "updateRestore",
      "updateFinish",
    ]),
    params: z.unknown().optional(),
  })
  .strict();
const answerSchema = z.object({ interactionId: z.string().uuid(), value: z.unknown() }).strict();
const cancelSchema = z.object({ interactionId: z.string().uuid().optional() }).strict();

export type DesktopProtocolRequest = z.infer<typeof requestSchema>;
export type DesktopInteraction = { id: string; kind: string; [key: string]: unknown };
type ProtocolMessage =
  | { id: string | null; ok: true; result: unknown }
  | { id: string | null; ok: false; error: { code: string; message: string } }
  | { event: "interaction"; interaction: DesktopInteraction };

class ProtocolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const cancelled = () => new ProtocolFailure("CANCELLED", "The operation was cancelled.");

/** The parser supplied by each hook validates responses before they enter the enrollment flow. */
export class DesktopInteractionBroker {
  private readonly pending = new Map<
    string,
    {
      parse(value: unknown): unknown;
      resolve(value: unknown): void;
      reject(reason: unknown): void;
      cleanup(): void;
    }
  >();
  private closed = false;

  constructor(
    private readonly emit: (message: {
      event: "interaction";
      interaction: DesktopInteraction;
    }) => Promise<void>,
  ) {}

  ask<T>(
    kind: string,
    payload: Record<string, unknown>,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.reject(cancelled());
    if (this.pending.size >= MAX_PENDING)
      return Promise.reject(new ProtocolFailure("BUSY", "Too many pending interactions."));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const abort = () => this.cancel(id);
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { parse, resolve: (value) => resolve(value as T), reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      void this.emit({ event: "interaction", interaction: { ...payload, id, kind } }).catch(() =>
        this.cancel(id),
      );
    });
  }

  respond(id: string, value: unknown): void {
    const entry = this.pending.get(id);
    if (!entry)
      throw new ProtocolFailure("INTERACTION_NOT_FOUND", "That interaction is no longer waiting.");
    let parsed: unknown;
    try {
      parsed = entry.parse(value);
    } catch {
      throw new ProtocolFailure("INVALID_RESPONSE", "The interaction response was invalid.");
    }
    this.pending.delete(id);
    entry.cleanup();
    entry.resolve(parsed);
  }

  cancel(id?: string): void {
    for (const [key, entry] of this.pending) {
      if (id !== undefined && key !== id) continue;
      this.pending.delete(key);
      entry.cleanup();
      entry.reject(cancelled());
    }
  }

  close(): void {
    this.closed = true;
    this.cancel();
  }
}

export interface DesktopProtocolContext {
  signal: AbortSignal;
  interactions: DesktopInteractionBroker;
}

/**
 * Lifecycle work is serialized. Response and cancellation frames bypass that queue so a native
 * prompt can complete the operation that is holding it. Protocol errors never expose input or
 * exception text, and writes wait for the writable's callback before accepting another frame.
 */
export async function runDesktopProtocol(options: {
  input: Readable;
  output: Writable;
  signal?: AbortSignal;
  handle(
    request: DesktopProtocolRequest,
    context: DesktopProtocolContext,
  ): Promise<unknown> | unknown;
}): Promise<void> {
  let writes = Promise.resolve();
  const send = (message: ProtocolMessage): Promise<void> => {
    let line: string;
    try {
      line = JSON.stringify({ version: 1, ...message }) + "\n";
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error();
    } catch {
      if (!("id" in message))
        return Promise.reject(
          new ProtocolFailure("FRAME_TOO_LARGE", "The interaction is too large."),
        );
      line =
        JSON.stringify({
          version: 1,
          id: message.id,
          ok: false,
          error: {
            code: "INVALID_RESULT",
            message: "The operation returned an unsupported result.",
          },
        }) + "\n";
    }
    const next = writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          options.output.write(line, (error) => (error ? reject(error) : resolve()));
        }),
    );
    // A failed channel stays failed. Each caller receives the rejection without unhandled tails.
    writes = next;
    void writes.catch(() => {});
    return next;
  };
  const failure = (id: string | null, code: string, message: string) =>
    send({ id, ok: false, error: { code, message } });
  const broker = new DesktopInteractionBroker(send);
  const session = new AbortController();
  let active: AbortController | undefined;
  const onAbort = () => {
    active?.abort();
    broker.close();
    options.input.destroy();
  };
  const onOutputError = () => {
    active?.abort();
    broker.close();
    options.input.destroy();
  };
  options.output.on("error", onOutputError);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let lifecycle = Promise.resolve();
  let pending = 0;
  const seen = new Set<string>();
  const processFrame = async (frame: Buffer): Promise<void> => {
    let json: unknown;
    try {
      json = JSON.parse(frame.toString("utf8"));
    } catch {
      await failure(null, "INVALID_JSON", "Expected one JSON request per line.");
      return;
    }
    const parsed = requestSchema.safeParse(json);
    if (!parsed.success) {
      await failure(null, "INVALID_REQUEST", "The desktop request was invalid.");
      return;
    }
    const request = parsed.data;
    if (seen.has(request.id)) {
      await failure(request.id, "DUPLICATE_ID", "Request IDs must be unique within a session.");
      return;
    }
    if (seen.size >= MAX_SESSION_REQUESTS) {
      await failure(request.id, "SESSION_LIMIT", "Restart the desktop connection to continue.");
      return;
    }
    seen.add(request.id);
    if (request.command === "respond") {
      const response = answerSchema.safeParse(request.params);
      if (!response.success) {
        await failure(request.id, "INVALID_RESPONSE", "The interaction response was invalid.");
        return;
      }
      try {
        broker.respond(response.data.interactionId, response.data.value);
        await send({ id: request.id, ok: true, result: null });
      } catch (error) {
        const known =
          error instanceof ProtocolFailure
            ? error
            : new ProtocolFailure("INVALID_RESPONSE", "The interaction response was invalid.");
        await failure(request.id, known.code, known.message);
      }
      return;
    }
    if (request.command === "cancel") {
      const response = cancelSchema.safeParse(request.params ?? {});
      if (!response.success) {
        await failure(request.id, "INVALID_REQUEST", "The cancellation request was invalid.");
        return;
      }
      if (response.data.interactionId === undefined) active?.abort();
      broker.cancel(response.data.interactionId);
      await send({ id: request.id, ok: true, result: null });
      return;
    }
    if (pending >= MAX_PENDING) {
      await failure(request.id, "BUSY", "Too many pending desktop operations.");
      return;
    }
    pending++;
    lifecycle = lifecycle.then(async () => {
      const controller = new AbortController();
      active = controller;
      const signal = AbortSignal.any([
        session.signal,
        controller.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      try {
        signal.throwIfAborted();
        const result = await options.handle(request, { signal, interactions: broker });
        signal.throwIfAborted();
        await send({ id: request.id, ok: true, result: result ?? null });
      } catch (error) {
        const known = signal.aborted
          ? cancelled()
          : error instanceof ProtocolFailure
            ? error
            : new ProtocolFailure("OPERATION_FAILED", "The desktop operation could not finish.");
        await failure(request.id, known.code, known.message);
      } finally {
        active = undefined;
        pending--;
      }
    });
    // Output failure must not turn every queued operation into an unhandled rejection.
    void lifecycle.catch(() => {});
  };
  let chunks: Buffer[] = [];
  let size = 0;
  let discarding = false;
  try {
    if (options.signal?.aborted) onAbort();
    for await (const chunk of options.input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline < 0 ? bytes.length : newline;
        const part = bytes.subarray(start, end);
        if (!discarding && size + part.length > MAX_FRAME_BYTES) {
          chunks = [];
          size = 0;
          discarding = true;
          await failure(null, "FRAME_TOO_LARGE", "The desktop request exceeded the frame limit.");
        }
        if (!discarding) {
          chunks.push(part);
          size += part.length;
        }
        if (newline < 0) break;
        if (!discarding) await processFrame(Buffer.concat(chunks, size));
        chunks = [];
        size = 0;
        discarding = false;
        start = newline + 1;
      }
    }
    if (size > 0 && !discarding) await processFrame(Buffer.concat(chunks, size));
  } finally {
    session.abort();
    active?.abort();
    broker.close();
    options.signal?.removeEventListener("abort", onAbort);
    try {
      await lifecycle;
      await writes;
    } finally {
      options.output.removeListener("error", onOutputError);
    }
  }
}
