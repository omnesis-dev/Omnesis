// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ownedProcessCleanupReceipt } from "@omnesis/core";

/** Terminal receipts dominate independent pending work without changing either proof. */
export function cleanupReceipt(...values: unknown[]): unknown | undefined {
  let pending: unknown;
  for (const value of values) {
    const receipt = ownedProcessCleanupReceipt(value);
    if (!receipt) continue;
    if (!receipt.pending) return value;
    pending ??= value;
  }
  return pending;
}

export function combinedCleanupErrors(errors: unknown[], message: string): unknown {
  if (errors.length === 1) return errors[0];
  const marked = cleanupReceipt(...errors);
  const receipt = ownedProcessCleanupReceipt(marked);
  const combined = new AggregateError(errors, message, marked ? { cause: marked } : undefined);
  return receipt ? Object.assign(combined, { cleanupFailure: receipt.failure }) : combined;
}

/** Retained accepted work and its close proof; status reads never start cleanup. */
export class OwnedCleanupLifecycle {
  private readonly active = new Set<Promise<unknown>>();
  private terminal: unknown;
  private held = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private closeSettled = false;
  private readonly pending = Object.assign(new Error("Owned cleanup remains pending"), {
    cleanupFailure: true,
    cleanupPending: true as const,
  });

  constructor(private readonly onUncertain?: () => void) {}

  get uncertain(): boolean {
    return this.held;
  }

  receipt(): unknown | undefined {
    return this.held
      ? this.terminal
      : this.active.size || (this.closing && !this.closeSettled)
        ? this.pending
        : undefined;
  }

  assertAdmitting(): void {
    if (this.held) throw this.terminal;
    if (this.closed) throw new Error("Owned cleanup lifecycle is closed");
  }

  observe(error: unknown): boolean {
    const receipt = ownedProcessCleanupReceipt(error);
    if (!receipt) return false;
    if (!this.held) {
      // A rejected operation supplies no retained late-join promise. Its marker is terminal.
      this.terminal = receipt.pending
        ? Object.assign(new Error("Owned cleanup is unconfirmed", { cause: error }), {
            cleanupFailure: receipt.failure,
          })
        : error;
      this.held = true;
      this.onUncertain?.();
    }
    return true;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    try {
      this.assertAdmitting();
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = Promise.resolve()
      .then(() => {
        this.assertAdmitting();
        return work();
      })
      .catch((error: unknown) => {
        this.observe(error);
        throw error;
      })
      .finally(() => {
        this.active.delete(operation);
      });
    this.active.add(operation);
    return operation;
  }

  close(...cleanup: (() => Promise<void>)[]): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const work = await Promise.allSettled([...this.active]);
      for (const result of work) if (result.status === "rejected") this.observe(result.reason);
      const results = await Promise.allSettled(cleanup.map((task) => Promise.resolve().then(task)));
      const errors: unknown[] = [];
      for (const result of results)
        if (result.status === "rejected") {
          this.observe(result.reason);
          errors.push(result.reason);
        }
      if (this.held) {
        if (!errors.length) throw this.terminal;
        const receipt = ownedProcessCleanupReceipt(this.terminal)!;
        throw Object.assign(
          new AggregateError([this.terminal, ...errors], "Owned cleanup is unconfirmed", {
            cause: this.terminal,
          }),
          { cleanupFailure: receipt.failure },
        );
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Owned cleanup failed");
    })().finally(() => {
      this.closeSettled = true;
    });
    return this.closing;
  }
}
