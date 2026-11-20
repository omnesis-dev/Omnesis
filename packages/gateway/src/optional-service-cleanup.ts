// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ownedProcessCleanupReceipt } from "./owned-process-cleanup.js";
import type { OwnedProcessCleanup } from "./owned-process-shutdown-fence.js";

interface OwnedService {
  cleanupFailure(): unknown;
  close(): Promise<void>;
}

/** Retain startup failures even when an optional service never reaches assignment. */
export class OptionalServiceCleanup implements OwnedProcessCleanup {
  private failure: Error | undefined;
  private readonly closures = new WeakMap<OwnedService, Promise<void>>();

  constructor(
    private readonly label: string,
    private readonly current: () => OwnedService | undefined | null,
  ) {}

  /** A rejected operation supplies no retained proof that could clear a pending marker. */
  captureFailure(error: unknown): boolean {
    const receipt = ownedProcessCleanupReceipt(error);
    if (!receipt) return false;
    this.failure ??= Object.assign(
      new Error(`${this.label} process cleanup is unconfirmed`, { cause: error }),
      { cleanupFailure: receipt.failure },
    );
    return true;
  }

  receipt(): unknown {
    return this.failure ?? this.current()?.cleanupFailure();
  }

  hasTerminalFailure(): boolean {
    const receipt = ownedProcessCleanupReceipt(this.receipt());
    return receipt !== undefined && !receipt.pending;
  }

  settle(): Promise<void> {
    const service = this.current();
    let proof = service ? this.closures.get(service) : undefined;
    if (service && !proof) {
      proof = Promise.resolve().then(() => service.close());
      this.closures.set(service, proof);
    }
    return (proof ?? Promise.resolve()).then(
      () => {
        if (this.failure) throw this.failure;
      },
      (error: unknown) => {
        this.captureFailure(error);
        if (this.failure)
          throw new AggregateError([this.failure, error], `${this.label} cleanup failed`, {
            cause: this.failure,
          });
        throw error;
      },
    );
  }
}

/** Stop independent optional services even when a peer's cleanup fails. */
export async function closeOptionalServices(
  owners: readonly OptionalServiceCleanup[],
): Promise<void> {
  const results = await Promise.allSettled(
    owners.map((owner) => Promise.resolve().then(() => owner.settle())),
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) throw errors[0];
  if (errors.length) {
    const marked = errors.find((error: unknown) => ownedProcessCleanupReceipt(error) !== undefined);
    throw new AggregateError(
      errors,
      "Optional service cleanup failed",
      marked ? { cause: marked } : undefined,
    );
  }
}
