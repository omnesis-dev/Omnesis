// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Key of one write-epoch scope: a source's cursor row (`""` = the shared
 * row, a device id = that member's own). Every claim, revoke and fenced
 * write on a row serializes behind this key.
 */
export function epochScope(sourceId: string, cursorRow = ""): string {
  return `${sourceId}\0${cursorRow}`;
}

interface AttemptAuthority {
  scope: string;
  epoch?: number;
  canceled: boolean;
  touchedAt: number;
}

const ATTEMPT_TTL_MS = 60 * 60 * 1000;

/**
 * Fair shared/exclusive barrier for one hierarchy level.
 *
 * Shared operations overlap. An exclusive operation closes the admission gate,
 * waits for admitted work to drain, then runs alone. Because it keeps the gate
 * until completion, shared work queued afterward cannot barge ahead and starve
 * a wipe. Completion never reacquires the gate, so draining cannot deadlock.
 */
class SharedExclusiveBarrier {
  private gateTail: Promise<void> = Promise.resolve();
  private active = 0;
  private drained: Promise<void> | undefined;
  private resolveDrained: (() => void) | undefined;

  private async acquireGate(): Promise<() => void> {
    const previous = this.gateTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gateTail = previous.then(() => current);
    await previous;
    return release;
  }

  async shared<T>(operation: () => Promise<T>): Promise<T> {
    const releaseGate = await this.acquireGate();
    this.active++;
    releaseGate();
    try {
      return await operation();
    } finally {
      this.active--;
      if (this.active === 0) {
        this.resolveDrained?.();
        this.drained = undefined;
        this.resolveDrained = undefined;
      }
    }
  }

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const releaseGate = await this.acquireGate();
    try {
      if (this.active > 0) {
        this.drained ??= new Promise<void>((resolve) => {
          this.resolveDrained = resolve;
        });
        await this.drained;
      }
      return await operation();
    } finally {
      releaseGate();
    }
  }
}

/**
 * Hierarchical write authority for source data:
 * global → source → cursor row.
 *
 * Collector claims and HTTP document, analytics, and sync-state ingests
 * participate at cursor level. Different sources — and different member rows
 * of one source — remain concurrent. A source wipe closes the source barrier
 * before its first store mutation; a provider wipe closes the global barrier.
 * Later participating work, including a previously unseen member row or
 * source, therefore cannot enter halfway through a multi-store wipe.
 */
export class SourceWriteEpochFence {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly attempts = new Map<string, AttemptAuthority>();
  private readonly globalBarrier = new SharedExclusiveBarrier();
  private readonly sourceBarriers = new Map<
    string,
    { barrier: SharedExclusiveBarrier; references: number }
  >();

  private async withSourceBarrier<T>(
    sourceId: string,
    mode: "shared" | "exclusive",
    operation: () => Promise<T>,
  ): Promise<T> {
    let entry = this.sourceBarriers.get(sourceId);
    if (!entry) {
      entry = { barrier: new SharedExclusiveBarrier(), references: 0 };
      this.sourceBarriers.set(sourceId, entry);
    }
    entry.references++;
    try {
      return await entry.barrier[mode](operation);
    } finally {
      entry.references--;
      if (entry.references === 0 && this.sourceBarriers.get(sourceId) === entry) {
        this.sourceBarriers.delete(sourceId);
      }
    }
  }

  private sourceFromScope(scope: string): string {
    const separator = scope.indexOf("\0");
    return separator < 0 ? scope : scope.slice(0, separator);
  }

  private attemptKey(scope: string, attemptId: string): string {
    return `${scope}\0${attemptId}`;
  }

  private pruneAttempts(now = Date.now()): void {
    for (const [key, attempt] of this.attempts) {
      if (now - attempt.touchedAt > ATTEMPT_TTL_MS) this.attempts.delete(key);
    }
  }

  private async runCursor<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(scope, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(scope) === tail) this.tails.delete(scope);
    }
  }

  async run<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const sourceId = this.sourceFromScope(scope);
    return this.globalBarrier.shared(() =>
      this.withSourceBarrier(sourceId, "shared", () => this.runCursor(scope, operation)),
    );
  }

  /**
   * Run one operation behind an exact set of cursor rows. Multi-source HTTP
   * ingest uses this to make its epoch validation and document write one
   * participating unit. Scopes are acquired in stable order so multi-scope
   * callers cannot each hold a scope the other needs.
   */
  async runAll<T>(scopes: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(scopes)].sort();
    const sourceIds = [...new Set(ordered.map((scope) => this.sourceFromScope(scope)))].sort();
    const withCursors = ordered.reduceRight<() => Promise<T>>(
      (inner, scope) => () => this.runCursor(scope, inner),
      operation,
    );
    const withSources = sourceIds.reduceRight<() => Promise<T>>(
      (inner, sourceId) => () => this.withSourceBarrier(sourceId, "shared", inner),
      withCursors,
    );
    return this.globalBarrier.shared(withSources);
  }

  /** Run a full source wipe before any later claim or ingest for that source. */
  runSourceExclusive<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
    return this.globalBarrier.shared(() =>
      this.withSourceBarrier(sourceId, "exclusive", operation),
    );
  }

  /** Run a provider-wide wipe before any later source claim or ingest. */
  runGlobalExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.globalBarrier.exclusive(operation);
  }

  async beginAttempt(
    scope: string,
    attemptId: string | undefined,
    claim: () => Promise<number>,
  ): Promise<number | undefined> {
    if (!attemptId) return this.run(scope, claim);
    return this.run(scope, async () => {
      this.pruneAttempts();
      const key = this.attemptKey(scope, attemptId);
      const prior = this.attempts.get(key);
      if (prior?.canceled) {
        this.attempts.delete(key);
        return undefined;
      }
      const epoch = await claim();
      this.attempts.set(key, {
        scope,
        epoch,
        canceled: false,
        touchedAt: Date.now(),
      });
      return epoch;
    });
  }

  async cancelAttempt(
    scope: string,
    attemptId: string | undefined,
    expectedEpoch: number | undefined,
    revoke: (epoch: number) => Promise<boolean>,
  ): Promise<boolean> {
    return this.run(scope, async () => {
      this.pruneAttempts();
      let epoch = expectedEpoch;
      if (attemptId) {
        const key = this.attemptKey(scope, attemptId);
        const prior = this.attempts.get(key);
        if (prior) {
          epoch ??= prior.epoch;
          this.attempts.delete(key);
        } else {
          // No record of the claim: either the cancel overtook it, or the
          // record is gone (aged out, or lost to a gateway restart). Tombstone
          // the attempt so a claim still in flight for it is refused. An epoch
          // the caller supplies is independent of this bookkeeping — it came
          // from the claim's own response — so it is still revoked below; the
          // revoke is a compare-and-swap, so a superseded epoch is a no-op.
          this.attempts.set(key, {
            scope,
            canceled: true,
            touchedAt: Date.now(),
          });
        }
      }
      return epoch === undefined ? false : revoke(epoch);
    });
  }
}
