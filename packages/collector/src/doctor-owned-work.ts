// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ownedProcessCleanupReceipt } from "@omnesis/core";

/** Terminal uncertainty dominates independently pending, positively joinable work. */
export function doctorCleanupReceipt(...values: unknown[]): unknown | undefined {
  let pending: unknown;
  for (const value of values) {
    const receipt = ownedProcessCleanupReceipt(value);
    if (!receipt) continue;
    if (!receipt.pending) return value;
    pending ??= value;
  }
  return pending;
}

/** Raw producer promises remain owned independently of their observation deadline. */
export class DoctorOwnedWork {
  private readonly active = new Map<unknown, Promise<unknown>>();
  private held = false;
  private terminal: unknown;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly pending = Object.assign(new Error("Collector doctor work remains active"), {
    cleanupFailure: undefined,
    cleanupPending: true as const,
  });

  constructor(private readonly changed?: () => void) {}

  cleanupFailure(): unknown | undefined {
    return this.held ? this.terminal : this.active.size ? this.pending : undefined;
  }
  get size(): number {
    return this.active.size;
  }
  has(key: unknown): boolean {
    return this.active.has(key);
  }
  assertAdmitting(): void {
    if (this.held) throw this.terminal;
    if (this.closed) throw new Error("Collector doctor work is closed");
  }
  private notify(): { error: unknown } | undefined {
    try {
      this.changed?.();
    } catch (error) {
      return { error };
    }
    return undefined;
  }
  observe(error: unknown): boolean {
    const receipt = ownedProcessCleanupReceipt(error);
    if (!receipt) return false;
    if (!this.held) {
      this.terminal = receipt.pending
        ? Object.assign(new Error("Collector doctor cleanup is unconfirmed", { cause: error }), {
            cleanupFailure: receipt.failure,
          })
        : error;
      this.held = true;
      this.notify();
    }
    return true;
  }

  run<T>(key: unknown, producer: () => Promise<T>): Promise<T> {
    try {
      this.assertAdmitting();
      if (this.active.has(key)) throw new Error("Collector doctor producer is already active");
    } catch (error) {
      return Promise.reject(error);
    }
    let refused: { error: unknown } | undefined;
    const work = Promise.resolve()
      .then(() => {
        if (refused) throw refused.error;
        this.assertAdmitting();
        return producer();
      })
      .catch((error: unknown) => {
        this.observe(error);
        throw error;
      })
      .finally(() => {
        if (this.active.get(key) === work) this.active.delete(key);
        // Settlement cannot launch work; notification errors cannot undo its proof.
        this.notify();
      });
    this.active.set(key, work);
    // The pending receipt is visible to the watchdog gate before any producer runs.
    refused = this.notify();
    return work;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.allSettled([...this.active.values()]).then((results) => {
      for (const result of results) if (result.status === "rejected") this.observe(result.reason);
      if (this.held) throw this.terminal;
    });
    return this.closing;
  }
}
