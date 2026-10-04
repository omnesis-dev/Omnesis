// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { HttpError } from "../errors.js";
import type { AuthContext } from "../routes/types.js";
import type { BrowserFindService } from "./BrowserFindService.js";

import type {
  FindSearchInput,
  FindSearchExecution,
  FindStreamEvent,
} from "../../search/find/types.js";

export interface BrowserFindSearchRunner {
  search(input: FindSearchInput, context: FindSearchExecution): Promise<void>;
}

/** Owns connection lifetime and per-credential admission for ephemeral searches. */
export class BrowserFindStreamService {
  private readonly active = new Map<string, number>();
  constructor(
    private readonly deps: {
      authority: Pick<BrowserFindService, "requireActive">;
      runner: BrowserFindSearchRunner;
      heartbeatMs?: number;
      maxConcurrent?: number;
      timeoutMs?: number;
      maxBufferedBytes?: number;
    },
  ) {}

  stream(auth: AuthContext, input: FindSearchInput, requestSignal: AbortSignal): Response {
    this.deps.authority.requireActive(auth);
    const caller = String(auth.tokenId);
    const count = this.active.get(caller) ?? 0;
    if (count >= (this.deps.maxConcurrent ?? 2))
      throw new HttpError(429, "FIND_CONCURRENCY_LIMIT", "Another Find search is still running");
    this.active.set(caller, count + 1);
    const abort = new AbortController();
    const encoder = new TextEncoder();
    let close = (): void => {};
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          let closed = false;
          let timer: ReturnType<typeof setInterval> | undefined;
          let deadline: ReturnType<typeof setTimeout> | undefined;
          const terminate = (): void => {
            if (closed) return;
            closed = true;
            abort.abort();
            if (timer) clearInterval(timer);
            if (deadline) clearTimeout(deadline);
            requestSignal.removeEventListener("abort", terminate);
            try {
              controller.close();
            } catch {
              /* Consumer already closed the stream. */
            }
          };
          close = terminate;
          const enqueue = (frame: string): void => {
            if (closed) return;
            try {
              const bytes = encoder.encode(frame);
              if (bytes.byteLength > (controller.desiredSize ?? 0)) {
                controller.error(new Error("Find stream exceeded its buffered output limit"));
                terminate();
                return;
              }
              controller.enqueue(bytes);
            } catch {
              terminate();
            }
          };
          const recheck = (): boolean => {
            try {
              this.deps.authority.requireActive(auth);
              return true;
            } catch {
              enqueue(
                `data: ${JSON.stringify({ type: "find.error", payload: { message: "Find permission is no longer active", code: "FIND_PERMISSION_REVOKED" } })}\n\n`,
              );
              terminate();
              return false;
            }
          };
          const heartbeat = (): void => {
            if (!closed && recheck()) enqueue(": hb\n\n");
          };
          const emit = (event: FindStreamEvent): void => {
            if (!closed && recheck()) enqueue(`data: ${JSON.stringify(event)}\n\n`);
          };
          if (requestSignal.aborted) terminate();
          else requestSignal.addEventListener("abort", terminate, { once: true });
          heartbeat();
          if (!closed) {
            timer = setInterval(heartbeat, this.deps.heartbeatMs ?? 25_000);
            timer.unref();
            deadline = setTimeout(() => {
              if (closed || !recheck()) return;
              enqueue(
                `data: ${JSON.stringify({ type: "find.error", payload: { message: "Find search exceeded its time limit. Try a narrower query.", code: "FIND_TIMEOUT" } })}\n\n`,
              );
              terminate();
            }, this.deps.timeoutMs ?? 180_000);
            deadline.unref();
          }
          void (async () => {
            try {
              abort.signal.throwIfAborted();
              await this.deps.runner.search(input, { signal: abort.signal, emit });
            } catch {
              if (!abort.signal.aborted)
                emit({
                  type: "find.error",
                  payload: { message: "Find search could not complete" },
                });
            } finally {
              terminate();
              const remaining = (this.active.get(caller) ?? 1) - 1;
              if (remaining > 0) this.active.set(caller, remaining);
              else this.active.delete(caller);
            }
          })();
        },
        cancel: () => close(),
      },
      {
        highWaterMark: this.deps.maxBufferedBytes ?? 4 * 1024 * 1024,
        size: (chunk) => chunk.byteLength,
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }
}
