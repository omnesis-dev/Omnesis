// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isWebCapturePolicy, type WebCapturePolicy } from "@omnesis/provider-web/capture-policy";
import type { DurableStore } from "../push/index.js";

/**
 * The browser's durable copy of the gateway-owned capture policy.
 *
 * The service worker is the only writer: it refreshes the copy from the
 * gateway when it is older than {@link CAPTURE_POLICY_TTL_MS}, on every
 * popup check, and after each of its own edits (whose responses carry the
 * whole policy). A browser without a copy captures nothing — the policy is
 * what says which pages may leave the browser, so its absence fails closed.
 */

export const CAPTURE_POLICY_KEY = "omnesis.capture.policy.v1";

/** How old the copy may be before the worker asks the gateway again. */
export const CAPTURE_POLICY_TTL_MS = 15 * 60 * 1000;

/** Common timed-pause durations offered in the popup, in milliseconds. */
export const PAUSE_ONE_HOUR_MS = 60 * 60 * 1000;
export const PAUSE_ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface CachedCapturePolicy {
  policy: WebCapturePolicy;
  /** Epoch-ms the copy was last confirmed against the gateway. */
  fetchedAt: number;
}

export async function readCachedPolicy(store: DurableStore): Promise<CachedCapturePolicy | null> {
  const raw = await store.get(CAPTURE_POLICY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedCapturePolicy>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !isWebCapturePolicy(parsed.policy) ||
      typeof parsed.fetchedAt !== "number" ||
      !Number.isFinite(parsed.fetchedAt)
    ) {
      return null;
    }
    return { policy: parsed.policy, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

export async function writeCachedPolicy(
  store: DurableStore,
  policy: WebCapturePolicy,
  fetchedAt: number,
): Promise<void> {
  await store.set(CAPTURE_POLICY_KEY, JSON.stringify({ policy, fetchedAt }));
}

/** Forget the copy; the next worker wake fetches the paired gateway's policy afresh. */
export async function clearCachedPolicy(store: DurableStore): Promise<void> {
  await store.set(CAPTURE_POLICY_KEY, "");
}

export function policyIsStale(cached: CachedCapturePolicy, now: number): boolean {
  return now - cached.fetchedAt >= CAPTURE_POLICY_TTL_MS || cached.fetchedAt > now;
}
