// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * In-memory registry of cross-device history-import flows (#588).
 *
 * A flow is started by an admin client (CLI / portal) calling
 * POST /admin/sources/:id/import-history. The gateway forwards an `import.begin`
 * command to the source's collector, which runs `source.importHistory()`
 * in-process and streams `import.progress` events followed by a terminal
 * `import.complete` (ok=true with a tally, or ok=false with an error).
 *
 * SSE subscribers (per flowId) get every event re-emitted so admin UIs can show
 * a live progress bar. Mirrors {@link AuthFlowRegistry} but for a one-shot
 * import rather than an auth handshake.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@omnesis/core";
import type { DeviceId } from "@omnesis/types";

const log = createLogger("gateway:import-flows");

export type ImportFlowState = "starting" | "running" | "completed" | "error";

/** Event emitted to SSE subscribers. Mirrors the collector's import events. */
export interface ImportFlowEvent {
  type: "progress" | "complete" | "snapshot";
  phase?: string;
  processed?: number;
  total?: number;
  detail?: string;
  ok?: boolean;
  imported?: number;
  merged?: number;
  skipped?: number;
  error?: string;
  /** Snapshot of the current flow (for type="snapshot"). */
  flow?: ImportFlow;
}

export interface ImportFlow {
  id: string;
  sourceId: string;
  deviceId: DeviceId;
  state: ImportFlowState;
  phase?: string;
  processed?: number;
  total?: number;
  detail?: string;
  imported?: number;
  merged?: number;
  skipped?: number;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

type Subscriber = (event: ImportFlowEvent) => void;

export class ImportFlowRegistry {
  private flows = new Map<string, ImportFlow>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private readonly ttlMs: number;

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? 60 * 60 * 1000; // imports can run minutes; 1h TTL
  }

  start(opts: { sourceId: string; deviceId: DeviceId }): ImportFlow {
    const flow: ImportFlow = {
      id: randomUUID(),
      sourceId: opts.sourceId,
      deviceId: opts.deviceId,
      state: "starting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.flows.set(flow.id, flow);
    return flow;
  }

  get(id: string): ImportFlow | null {
    const flow = this.flows.get(id);
    if (!flow) return null;
    if (Date.now() - flow.createdAt > this.ttlMs) {
      this.expire(id);
      return null;
    }
    return flow;
  }

  /** Mutate a flow record WITHOUT fanning out to subscribers (e.g. the cancel
   *  route marks state; the collector remains the sole terminal-event emitter). */
  update(id: string, patch: Partial<Omit<ImportFlow, "id" | "createdAt">>): ImportFlow | null {
    const flow = this.flows.get(id);
    if (!flow) return null;
    Object.assign(flow, patch, { updatedAt: Date.now() });
    return flow;
  }

  list(): ImportFlow[] {
    return Array.from(this.flows.values());
  }

  /**
   * Whether an import is in flight for this source, without materializing the
   * list.
   *
   * A caller on a hot path — the event bus runs its handlers synchronously on
   * the ingest path — asks this per event, and `list()` allocates an array
   * each time it is asked. The registry holds at most a handful of flows, so
   * the scan is cheap; the allocation is the part worth not doing.
   */
  isImporting(sourceId: string): boolean {
    const now = Date.now();
    for (const flow of this.flows.values()) {
      if (flow.sourceId !== sourceId) continue;
      if (flow.state !== "starting" && flow.state !== "running") continue;
      // Same TTL `get()` applies. A collector that died mid-import leaves a
      // flow reading `running` until the cleanup sweep removes it, and a
      // caller asking "is an import in flight?" would be told yes for an hour
      // about an import that ended when the process did.
      if (now - flow.createdAt > this.ttlMs) continue;
      return true;
    }
    return false;
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, flow] of this.flows) {
      if (now - flow.createdAt > this.ttlMs) {
        this.expire(id);
        removed++;
      }
    }
    return removed;
  }

  private expire(id: string): void {
    const subs = this.subscribers.get(id);
    if (subs) {
      const event: ImportFlowEvent = { type: "complete", ok: false, error: "expired" };
      for (const sub of subs) {
        try {
          sub(event);
        } catch (err) {
          log.warn(`SSE subscriber for import ${id} threw on expiry: ${String(err)}`);
        }
      }
    }
    this.flows.delete(id);
    this.subscribers.delete(id);
  }

  /** Subscribe to events for a flow. Returns an unsubscribe function. */
  subscribe(flowId: string, handler: Subscriber): () => void {
    let set = this.subscribers.get(flowId);
    if (!set) {
      set = new Set<Subscriber>();
      this.subscribers.set(flowId, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set?.size === 0) this.subscribers.delete(flowId);
    };
  }

  /** Apply a collector event (import.progress / import.complete) and fan out. */
  ingestEvent(flowId: string, event: ImportFlowEvent): ImportFlow | null {
    const flow = this.get(flowId);
    if (!flow) return null;

    if (event.type === "progress") {
      flow.state = "running";
      if (event.phase !== undefined) flow.phase = event.phase;
      if (event.processed !== undefined) flow.processed = event.processed;
      if (event.total !== undefined) flow.total = event.total;
      if (event.detail !== undefined) flow.detail = event.detail;
    } else if (event.type === "complete") {
      if (event.ok === false) {
        flow.state = "error";
        flow.errorMessage = event.error;
      } else {
        flow.state = "completed";
        flow.imported = event.imported;
        flow.merged = event.merged;
        flow.skipped = event.skipped;
      }
    }
    flow.updatedAt = Date.now();

    for (const sub of this.subscribers.get(flowId) ?? []) {
      try {
        sub(event);
      } catch (err) {
        log.warn(`SSE subscriber for import ${flowId} threw on ${event.type}: ${String(err)}`);
      }
    }
    return flow;
  }
}
