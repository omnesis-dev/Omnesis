// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceInstance, SourceReadAccessResult } from "@omnesis/source-sdk";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { DoctorOwnedWork } from "./doctor-owned-work.js";

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
  private readonly work: DoctorOwnedWork;
  private readonly stopping = new AbortController();

  constructor(
    private readonly budgets = { probeMs: PROBE_TIMEOUT_MS, scanMs: SCAN_TIMEOUT_MS },
    changed?: () => void,
  ) {
    this.work = new DoctorOwnedWork(changed);
  }

  cleanupFailure(): unknown | undefined {
    return this.work.cleanupFailure();
  }
  close(): Promise<void> {
    const joined = this.work.close();
    this.stopping.abort();
    return joined;
  }

  async collect(sources: DoctorReadAccessSource[], signal: AbortSignal): Promise<AccessEntry[]> {
    this.work.assertAdmitting();
    const controller = new AbortController();
    const scanSignal = AbortSignal.any([signal, controller.signal, this.stopping.signal]);
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
    this.work.assertAdmitting();
    if (signal.aborted || this.work.has(instance) || this.work.size >= PROBE_CONCURRENCY) {
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
    const work = this.work
      .run(instance, async () => {
        probeSignal.throwIfAborted();
        return instance.probeReadAccess!({ signal: probeSignal });
      })
      .catch((error: unknown): SourceReadAccessResult => {
        if (ownedProcessCleanupReceipt(error) !== undefined) throw error;
        return { status: "unavailable" };
      });
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
