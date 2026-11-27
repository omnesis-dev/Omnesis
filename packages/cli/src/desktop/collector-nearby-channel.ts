// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  ManagedDesktopNearbyCleanupError,
  managedDesktopNearbySnapshotSchema,
} from "@omnesis/core";
import { DesktopNearbyHints } from "./nearby-hints.js";
import type { ChildProcess } from "node:child_process";
import type { DesktopProfile } from "./environment.js";

const request = z
  .object({
    type: z.enum(["desktop-nearby-request", "desktop-nearby-cancel"]),
    id: z.string().uuid(),
  })
  .strict();
const response = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("desktop-nearby-response"),
      id: z.string().uuid(),
      snapshot: managedDesktopNearbySnapshotSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("desktop-nearby-unconfirmed"), id: z.string().uuid() }).strict(),
]);
function frame(value: unknown, limit: number): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value) > limit) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Only the retained collector ChildProcess owns this channel; JSON carries no target or scope. */
export function desktopCollectorNearbyParent(
  child: ChildProcess,
  profile: DesktopProfile,
  lifetime: AbortSignal,
  provider: Pick<
    DesktopNearbyHints,
    "snapshot" | "remaining" | "close" | "joinRetained"
  > = new DesktopNearbyHints(profile),
  now: () => number = performance.now.bind(performance),
) {
  let closing: Promise<void> | undefined;
  const stopped = new AbortController();
  let current: { id: string; cancel: AbortController; done: Promise<void> } | undefined;
  let tokens = 2,
    replenished = now();
  const send = (value: unknown) => {
    const text = JSON.stringify(value);
    if (stopped.signal.aborted || !child.connected || Buffer.byteLength(text) > 4096) return;
    try {
      child.send(text, () => {});
    } catch {
      /* A closed exact owner never becomes a successor. */
    }
  };
  const message = (value: unknown) => {
    const parsed = request.safeParse(frame(value, 256));
    if (!parsed.success || stopped.signal.aborted) return;
    const { type, id } = parsed.data;
    if (type === "desktop-nearby-cancel") {
      if (current?.id === id) current.cancel.abort();
      return;
    }
    const observed = now();
    tokens = Math.min(2, tokens + (observed - replenished) / 5000);
    replenished = observed;
    if (current || tokens < 1) {
      send({ type: "desktop-nearby-response", id });
      return;
    }
    tokens--;
    const cancel = new AbortController();
    const signal = AbortSignal.any([
      lifetime,
      stopped.signal,
      cancel.signal,
      AbortSignal.timeout(5000),
    ]);
    const held = { id, cancel, done: Promise.resolve() };
    current = held;
    held.done = (async () => {
      try {
        await provider.snapshot(signal);
        if (!signal.aborted && current === held)
          send({ type: "desktop-nearby-response", id, snapshot: provider.remaining() });
      } catch (error) {
        if (!signal.aborted && current === held)
          send({
            type:
              error instanceof ManagedDesktopNearbyCleanupError
                ? "desktop-nearby-unconfirmed"
                : "desktop-nearby-response",
            id,
          });
      } finally {
        if (current === held) current = undefined;
      }
    })();
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      stopped.abort();
      current?.cancel.abort();
      child.off("message", message);
      child.off("disconnect", disconnected);
      child.off("exit", disconnected);
      lifetime.removeEventListener("abort", disconnected);
      const pending = current?.done;
      try {
        await provider.close();
      } catch (error) {
        if (!(error instanceof ManagedDesktopNearbyCleanupError)) throw error;
        // Keep the daemon's control listener and runtime-owner lease alive. No replacement or clean
        // daemon exit can follow until this exact native query supplies physical joined evidence.
        await provider.joinRetained();
      }
      await pending;
    })());
  const disconnected = () => {
    void close().catch(() => undefined);
  };
  child.on("message", message);
  child.once("disconnect", disconnected);
  child.once("exit", disconnected);
  lifetime.addEventListener("abort", disconnected, { once: true });
  if (lifetime.aborted || !child.connected) disconnected();
  return { close };
}

/** DATA-bearing collector: an exact parent IPC request, never a privileged native subprocess. */
export class DesktopCollectorNearbyHints {
  constructor(
    private readonly channel: Pick<
      NodeJS.Process,
      "send" | "connected" | "on" | "off" | "once"
    > = process,
  ) {}
  private readonly stopped = new AbortController();
  private pending?: { cancel(): void; done: Promise<unknown> };
  private closing?: Promise<void>;
  private unconfirmed = false;
  snapshot(signal: AbortSignal): Promise<unknown> {
    if (this.unconfirmed) return Promise.reject(new ManagedDesktopNearbyCleanupError(undefined));
    signal.throwIfAborted();
    this.stopped.signal.throwIfAborted();
    if (this.pending || !this.channel.connected || typeof this.channel.send !== "function")
      return Promise.resolve([]);
    const id = randomUUID(),
      began = performance.now();
    const active = AbortSignal.any([signal, this.stopped.signal, AbortSignal.timeout(5000)]);
    let cancel!: () => void;
    const done = new Promise<unknown>((resolve, reject) => {
      let terminal = false;
      const finish = (value: unknown, error?: unknown) => {
        if (terminal) return;
        terminal = true;
        this.channel.off("message", message);
        this.channel.off("disconnect", disconnected);
        active.removeEventListener("abort", canceled);
        if (error !== undefined) reject(error);
        else resolve(value);
      };
      const message = (value: unknown) => {
        const parsed = response.safeParse(frame(value, 4096));
        if (!parsed.success || parsed.data.id !== id) return;
        if (parsed.data.type === "desktop-nearby-unconfirmed") {
          this.unconfirmed = true;
          finish([], new ManagedDesktopNearbyCleanupError(undefined));
          return;
        }
        const elapsed = Math.max(0, performance.now() - began);
        finish(
          parsed.data.snapshot?.candidates
            .filter((value) => value.remainingMs > elapsed)
            .map(({ address, port }) => ({ address, port })) ?? [],
        );
      };
      const disconnected = () => finish([]);
      const canceled = () => {
        if (this.channel.connected) {
          try {
            this.channel.send?.(JSON.stringify({ type: "desktop-nearby-cancel", id }), () => {});
          } catch {
            /* Owner gone. */
          }
        }
        finish([], active.reason);
      };
      cancel = canceled;
      this.channel.on("message", message);
      this.channel.once("disconnect", disconnected);
      active.addEventListener("abort", canceled, { once: true });
      if (active.aborted) {
        canceled();
        return;
      }
      try {
        this.channel.send!(JSON.stringify({ type: "desktop-nearby-request", id }), (error) => {
          if (error) finish([]);
        });
      } catch {
        finish([]);
      }
    });
    const held = {
      cancel: () => cancel(),
      done: done.finally(() => {
        if (this.pending === held) this.pending = undefined;
      }),
    };
    this.pending = held;
    return held.done;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.stopped.abort();
      this.pending?.cancel();
      await this.pending?.done.catch(() => undefined);
    })());
  }
}
