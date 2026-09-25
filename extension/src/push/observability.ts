// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  QUEUE_CORRUPTION_KEY,
  QUEUE_OVERFLOW_KEY,
  type QueueCorruption,
  type QueueOverflow,
} from "./queue.js";
import type { DurableStore, QueueItem } from "./types.js";

const PUSH_HEALTH_KEY = "omnesis.push.health.v1";
export const PUSH_SERVER_STATE_KEY = "omnesis.push.serverState.v1";
const PUSH_RECENT_KEY = "omnesis.push.recent.v1";
const PUSH_CONNECTIVITY_KEY = "omnesis.push.connectivity.v1";
const PUSH_CHECKED_KEY = "omnesis.push.checked.v1";
const PUSH_FAILURE_KEY = "omnesis.push.failure.v1";
const PUSH_RETRY_KEY = "omnesis.push.retry.v1";
const RECENT_CAP = 50;
const storeWriteLanes = new WeakMap<DurableStore, Promise<void>>();

export interface PushHealth {
  ok: boolean;
  reason?: string;
  at: number;
}

export interface PushFailure {
  reason: string;
  status: number;
  kind: QueueItem["kind"];
  at: number;
  count: number;
}

export interface PushRetry {
  itemId: string;
  kind: QueueItem["kind"];
  status?: number;
  reason: string;
  attempts: number;
  nextRetryAt: number;
  at: number;
}

export interface PushServerState {
  state: "removed" | "paused";
  reason: string;
  at: number;
}

/** A recent successfully synced page. Page bodies are never retained here. */
export interface RecentDelivery {
  title: string;
  url: string;
  kind: "document";
  at: number;
}

export interface Connectivity {
  reachable: boolean;
  degraded?: boolean;
  reason?: string;
  at: number;
}

/** Runtime-validated access to the push pipeline's durable diagnostic state. */
export class PushObservability {
  constructor(
    private readonly store: DurableStore,
    private readonly sessionId = "",
    private readonly generation = 0,
  ) {}

  getHealth(): Promise<PushHealth | null> {
    return this.readValidated(PUSH_HEALTH_KEY, isPushHealth);
  }

  writeHealth(health: PushHealth): Promise<void> {
    return this.writeSnapshot(PUSH_HEALTH_KEY, health);
  }

  getFailure(): Promise<PushFailure | null> {
    return this.readValidated(PUSH_FAILURE_KEY, isPushFailure);
  }

  async writeFailure(failure: Omit<PushFailure, "count">): Promise<void> {
    await serializeStoreWrite(this.store, async () => {
      const previous = await this.getFailure();
      const sameFailure =
        previous?.kind === failure.kind &&
        previous.status === failure.status &&
        previous.reason === failure.reason;
      await this.store.set(
        PUSH_FAILURE_KEY,
        JSON.stringify({ ...failure, count: (sameFailure ? previous.count : 0) + 1 }),
      );
    });
  }

  getRetry(): Promise<PushRetry | null> {
    return this.readValidated(PUSH_RETRY_KEY, isPushRetry);
  }

  writeRetry(retry: PushRetry): Promise<void> {
    return this.writeSnapshot(PUSH_RETRY_KEY, retry);
  }

  clearRetry(): Promise<void> {
    return serializeStoreWrite(this.store, () => this.store.set(PUSH_RETRY_KEY, ""));
  }

  getQueueCorruption(): Promise<QueueCorruption | null> {
    return this.readValidated(QUEUE_CORRUPTION_KEY, isQueueCorruption);
  }

  getQueueOverflow(): Promise<QueueOverflow | null> {
    return this.readValidated(QUEUE_OVERFLOW_KEY, isQueueOverflow);
  }

  getServerState(): Promise<PushServerState | null> {
    return this.readValidated(PUSH_SERVER_STATE_KEY, isPushServerState);
  }

  writeServerState(state: PushServerState): Promise<void> {
    return this.writeSnapshot(PUSH_SERVER_STATE_KEY, state);
  }

  clearServerState(): Promise<void> {
    return serializeStoreWrite(this.store, () => this.store.set(PUSH_SERVER_STATE_KEY, ""));
  }

  async getRecentDeliveries(): Promise<RecentDelivery[]> {
    const raw = await this.store.get(PUSH_RECENT_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(isRecentDelivery);
    } catch {
      // Invalid external storage is ignored in memory; readers never rewrite it.
    }
    return [];
  }

  async prependRecent(deliveries: RecentDelivery[]): Promise<void> {
    if (deliveries.length === 0) return;
    await serializeStoreWrite(this.store, async () => {
      const prior = await this.getRecentDeliveries();
      await this.store.set(
        PUSH_RECENT_KEY,
        JSON.stringify([...deliveries, ...prior].slice(0, RECENT_CAP)),
      );
    });
  }

  getConnectivity(): Promise<Connectivity | null> {
    return this.readValidated(PUSH_CONNECTIVITY_KEY, isConnectivity);
  }

  writeConnectivity(connectivity: Connectivity): Promise<void> {
    return this.writeSnapshot(PUSH_CONNECTIVITY_KEY, connectivity);
  }

  async getLastCheckedAt(): Promise<number | null> {
    const raw = await this.store.get(PUSH_CHECKED_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { at?: unknown };
      return isFiniteTimestamp(parsed.at) ? parsed.at : null;
    } catch {
      return null;
    }
  }

  async writeChecked(at: number): Promise<void> {
    await serializeStoreWrite(this.store, async () => {
      const raw = await this.store.get(PUSH_CHECKED_KEY);
      if (raw) {
        try {
          if (snapshotIsNewer(raw, at, this.sessionId, this.generation)) return;
        } catch {
          // Replace malformed state below.
        }
      }
      await this.store.set(
        PUSH_CHECKED_KEY,
        JSON.stringify({ at, sessionId: this.sessionId, generation: this.generation }),
      );
    });
  }

  private async writeSnapshot(key: string, value: { at: number }): Promise<void> {
    await serializeStoreWrite(this.store, async () => {
      const raw = await this.store.get(key);
      if (raw) {
        try {
          if (snapshotIsNewer(raw, value.at, this.sessionId, this.generation)) return;
        } catch {
          // Replace malformed state with the valid snapshot below.
        }
      }
      await this.store.set(
        key,
        JSON.stringify({ ...value, sessionId: this.sessionId, generation: this.generation }),
      );
    });
  }

  private async readValidated<T>(
    key: string,
    guard: (value: unknown) => value is T,
  ): Promise<T | null> {
    const raw = await this.store.get(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return guard(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function serializeStoreWrite<T>(store: DurableStore, work: () => Promise<T>): Promise<T> {
  const previous = storeWriteLanes.get(store) ?? Promise.resolve();
  const result = previous.then(work, work);
  storeWriteLanes.set(
    store,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

function snapshotIsNewer(raw: string, at: number, sessionId: string, generation: number): boolean {
  const previous = JSON.parse(raw) as {
    at?: unknown;
    sessionId?: unknown;
    generation?: unknown;
  };
  const previousGeneration = isFiniteNonNegativeInteger(previous.generation)
    ? previous.generation
    : 0;
  const sameSession = previous.sessionId === sessionId && sessionId.length > 0;
  return (
    (sameSession && previousGeneration > generation) ||
    ((!sameSession || previousGeneration === generation) &&
      isFiniteTimestamp(previous.at) &&
      previous.at > at)
  );
}

export async function clearPushServerState(store: DurableStore): Promise<void> {
  await store.set(PUSH_SERVER_STATE_KEY, "");
}

export async function clearPushObservability(store: DurableStore): Promise<void> {
  await store.set(PUSH_RECENT_KEY, "");
  await store.set(PUSH_CONNECTIVITY_KEY, "");
  await store.set(PUSH_CHECKED_KEY, "");
  await store.set(PUSH_RETRY_KEY, "");
  await clearPushDataLoss(store);
}

export async function clearPushDataLoss(store: DurableStore): Promise<void> {
  await store.set(PUSH_FAILURE_KEY, "");
  await store.set(QUEUE_CORRUPTION_KEY, "");
  await store.set(QUEUE_OVERFLOW_KEY, "");
}

export async function clearPushHealth(store: DurableStore): Promise<void> {
  await store.set(PUSH_HEALTH_KEY, "");
  await store.set(PUSH_CONNECTIVITY_KEY, "");
  await store.set(PUSH_CHECKED_KEY, "");
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function isPushHealth(value: unknown): value is PushHealth {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<PushHealth>;
  return (
    typeof item.ok === "boolean" &&
    isFiniteTimestamp(item.at) &&
    (item.reason === undefined || typeof item.reason === "string")
  );
}

function isPushFailure(value: unknown): value is PushFailure {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<PushFailure>;
  return (
    typeof item.reason === "string" &&
    typeof item.status === "number" &&
    (item.kind === "document" || item.kind === "visit") &&
    isFiniteTimestamp(item.at) &&
    isFiniteNonNegativeInteger(item.count)
  );
}

function isPushRetry(value: unknown): value is PushRetry {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<PushRetry>;
  return (
    typeof item.itemId === "string" &&
    (item.kind === "document" || item.kind === "visit") &&
    (item.status === undefined || typeof item.status === "number") &&
    typeof item.reason === "string" &&
    isFiniteNonNegativeInteger(item.attempts) &&
    isFiniteTimestamp(item.nextRetryAt) &&
    isFiniteTimestamp(item.at)
  );
}

function isPushServerState(value: unknown): value is PushServerState {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<PushServerState>;
  return (
    (item.state === "paused" || item.state === "removed") &&
    typeof item.reason === "string" &&
    isFiniteTimestamp(item.at)
  );
}

function isRecentDelivery(value: unknown): value is RecentDelivery {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<RecentDelivery>;
  return (
    item.kind === "document" &&
    typeof item.title === "string" &&
    typeof item.url === "string" &&
    isFiniteTimestamp(item.at)
  );
}

function isConnectivity(value: unknown): value is Connectivity {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<Connectivity>;
  return (
    typeof item.reachable === "boolean" &&
    (item.degraded === undefined || typeof item.degraded === "boolean") &&
    (item.reason === undefined || typeof item.reason === "string") &&
    isFiniteTimestamp(item.at)
  );
}

function isQueueCorruption(value: unknown): value is QueueCorruption {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<QueueCorruption>;
  return (
    isFiniteTimestamp(item.at) &&
    (item.discarded === null || isFiniteNonNegativeInteger(item.discarded))
  );
}

function isQueueOverflow(value: unknown): value is QueueOverflow {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<QueueOverflow>;
  return (
    isFiniteTimestamp(item.at) &&
    isFiniteNonNegativeInteger(item.discardedDocuments) &&
    isFiniteNonNegativeInteger(item.discardedVisits)
  );
}
