// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceInstance, SourceReadAccessResult } from "@omnesis/source-sdk";

export interface DoctorReadAccessSource {
  sourceId: string;
  instance: Pick<SourceInstance, "probeReadAccess" | "probeLocalStores">;
}

type AccessEntry = SourceReadAccessResult & { sourceId: string };

// Safety ceilings keep a health scan below the fleet result deadline. A stuck
// filesystem operation remains tracked until its provider closes its handles.
const PROBE_TIMEOUT_MS = 5_000;
const SCAN_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 2;

export class DoctorReadAccess {
  private readonly pending = new Set<DoctorReadAccessSource["instance"]>();

  constructor(private readonly budgets = { probeMs: PROBE_TIMEOUT_MS, scanMs: SCAN_TIMEOUT_MS }) {}

  async collect(sources: DoctorReadAccessSource[], signal: AbortSignal): Promise<AccessEntry[]> {
    const controller = new AbortController();
    const scanSignal = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), this.budgets.scanMs);
    timer.unref();
    const results: AccessEntry[] = new Array(sources.length);
    let next = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(PROBE_CONCURRENCY, sources.length) }, async () => {
          while (next < sources.length) {
            const index = next++;
            const source = sources[index]!;
            results[index] = {
              ...(await this.probe(source.instance, scanSignal)),
              sourceId: source.sourceId,
            };
          }
        }),
      );
      return results;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async probe(
    instance: DoctorReadAccessSource["instance"],
    signal: AbortSignal,
  ): Promise<SourceReadAccessResult> {
    if (signal.aborted || this.pending.has(instance) || this.pending.size >= PROBE_CONCURRENCY) {
      return { status: "unavailable" };
    }
    if (!instance.probeReadAccess) return { status: "unsupported" };
    const controller = new AbortController();
    const probeSignal = AbortSignal.any([signal, controller.signal]);
    let onAbort: () => void = () => {};
    const aborted = new Promise<SourceReadAccessResult>((resolve) => {
      onAbort = () => resolve({ status: "unavailable" });
      probeSignal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), this.budgets.probeMs);
    timer.unref();
    this.pending.add(instance);
    const work = Promise.resolve()
      .then(() => {
        probeSignal.throwIfAborted();
        return instance.probeReadAccess!({ signal: probeSignal });
      })
      .catch((): SourceReadAccessResult => ({ status: "unavailable" }))
      .finally(() => this.pending.delete(instance));
    try {
      const result = await Promise.race([work, aborted]);
      return probeSignal.aborted ? { status: "unavailable" } : result;
    } finally {
      clearTimeout(timer);
      probeSignal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
}
