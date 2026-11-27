// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { ManagedDesktopNearbyCleanupError } from "@omnesis/core";
import { directCandidateSchema, type DirectCandidate } from "./direct-path.js";

/** Optional discovery is untrusted input. Only authenticated gateway metadata may be saved. */
export interface NearbyGatewayHints {
  snapshot(signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

/** Optional address observation cannot consume the whole existing authenticated refresh budget. */
export async function readNearbyHints(
  provider: NearbyGatewayHints | undefined,
  signal: AbortSignal,
  expire: (milliseconds: number) => AbortSignal = (milliseconds) =>
    AbortSignal.timeout(milliseconds),
): Promise<unknown> {
  signal.throwIfAborted();
  if (!provider) return [];
  const optional = AbortSignal.any([signal, expire(750)]);
  try {
    // The provider retains physical cleanup: expiry is validity, not permission to detach a query.
    const hints = await provider.snapshot(optional);
    signal.throwIfAborted();
    return optional.aborted ? [] : hints;
  } catch (error) {
    if (error instanceof ManagedDesktopNearbyCleanupError) throw error;
    signal.throwIfAborted();
    return [];
  }
}

const pool = z.array(directCandidateSchema).max(8);
const key = (value: DirectCandidate): string => {
  // The pool schema already requires numeric IPs; URL only canonicalizes equivalent IPv6 text.
  const address = value.address.includes(":")
    ? new URL(`https://[${value.address}]`).hostname
    : value.address;
  return `${address}:${value.port}`;
};

/** Per transport: neither stale saved addresses nor unrelated advertisements own every early slot. */
export class NearbyDialOrder {
  private knownOffset = 0;
  private nearbyOffset = 0;
  private nearbyFirst = false;

  next(known: DirectCandidate[], untrusted: unknown): DirectCandidate[] {
    const parsed = pool.safeParse(untrusted);
    const fresh = parsed.success ? parsed.data : [];
    const saved = pool.parse(known);
    const rotate = (values: DirectCandidate[], offset: number): DirectCandidate[] =>
      values.length === 0
        ? []
        : [...values.slice(offset % values.length), ...values.slice(0, offset % values.length)];
    const left = rotate(saved, this.knownOffset);
    const right = rotate(fresh, this.nearbyOffset);
    this.knownOffset = saved.length ? (this.knownOffset + 1) % saved.length : 0;
    this.nearbyOffset = fresh.length ? (this.nearbyOffset + 1) % fresh.length : 0;
    const first = this.nearbyFirst ? right : left;
    const second = this.nearbyFirst ? left : right;
    this.nearbyFirst = !this.nearbyFirst;
    const result: DirectCandidate[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < Math.max(first.length, second.length) && result.length < 8; i++) {
      for (const candidate of [first[i], second[i]]) {
        if (!candidate || seen.has(key(candidate)) || result.length === 8) continue;
        seen.add(key(candidate));
        result.push({ ...candidate });
      }
    }
    return result;
  }
}

/** Optional ownership only: ordinary headless callers retain their exact transport object. */
export async function withNearbyGatewayHints<T extends { close(): Promise<void> }>(
  provider: NearbyGatewayHints | undefined,
  start: () => Promise<T | undefined>,
): Promise<T | undefined> {
  if (!provider) return start();
  let nearbyClosing: Promise<void> | undefined;
  const closeNearbyOnce = (): Promise<void> =>
    (nearbyClosing ??= Promise.resolve()
      .then(() => provider.close())
      .catch((error: unknown) => {
        if (error instanceof ManagedDesktopNearbyCleanupError) nearbyClosing = undefined;
        throw error;
      }));
  let transport: T | undefined;
  try {
    transport = await start();
  } catch (error) {
    try {
      await closeNearbyOnce();
    } catch (cleanup) {
      if (cleanup !== error)
        throw new AggregateError([error, cleanup], "Nearby transport startup and cleanup failed", {
          cause: cleanup,
        });
    }
    throw error;
  }
  if (!transport) {
    await closeNearbyOnce();
    return undefined;
  }
  const owned = transport;
  let closing: Promise<void> | undefined;
  let transportClosing: Promise<void> | undefined;
  return {
    ...owned,
    close: () =>
      (closing ??= (async () => {
        // Schedule both operations even if one close implementation throws synchronously.
        const results = await Promise.allSettled([
          (transportClosing ??= Promise.resolve().then(() => owned.close())),
          closeNearbyOnce(),
        ]);
        const failures = results.filter(
          (value): value is PromiseRejectedResult => value.status === "rejected",
        );
        if (failures.length === 1) throw failures[0]!.reason;
        if (failures.length > 1)
          throw new AggregateError(
            failures.map((value) => value.reason),
            "Nearby transport cleanup failed",
          );
      })().catch((error: unknown) => {
        const failures = error instanceof AggregateError ? error.errors : [error];
        if (failures.some((failure) => failure instanceof ManagedDesktopNearbyCleanupError))
          closing = undefined;
        throw error;
      })),
  };
}
