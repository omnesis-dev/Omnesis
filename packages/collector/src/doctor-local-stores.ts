// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The collector's inventory of the encrypted stores its sources keep on this
 * host, gathered for the health check by asking each source to inspect its
 * own. The doctor never learns a path or an engine: a source answers with
 * the key name each store opens with and what it found, so the shared
 * evaluator can say whether the host's keys are protecting what is on disk
 * without knowing which source wrote it.
 *
 * Probes run read-only under the same budgets as the read-access probes: a
 * bounded number at once, each with its own deadline, and a source whose
 * inspection does not finish is left out rather than blocking the run.
 */

import type { LocalStoreProbeResult } from "@omnesis/source-sdk";
import type { DoctorLocalStore } from "@omnesis/core/doctor";
import type { DoctorReadAccessSource } from "./doctor-read-access.js";

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_CONCURRENCY = 4;

export class DoctorLocalStores {
  constructor(private readonly probeMs = PROBE_TIMEOUT_MS) {}

  async collect(
    sources: DoctorReadAccessSource[],
    signal: AbortSignal,
  ): Promise<DoctorLocalStore[]> {
    const results: DoctorLocalStore[][] = new Array(sources.length).fill([]);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, sources.length) }, async () => {
        while (next < sources.length) {
          const index = next++;
          const source = sources[index]!;
          results[index] = (await this.probe(source.instance, signal)).map((store) => ({
            sourceId: source.sourceId,
            keyName: store.keyName,
            label: store.label,
            state: store.state,
            ...(store.detail ? { detail: store.detail } : {}),
          }));
        }
      }),
    );
    return results.flat();
  }

  private async probe(
    instance: DoctorReadAccessSource["instance"],
    signal: AbortSignal,
  ): Promise<LocalStoreProbeResult[]> {
    if (signal.aborted || !instance.probeLocalStores) return [];
    const controller = new AbortController();
    const probeSignal = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), this.probeMs);
    timer.unref();
    let onAbort: () => void = () => {};
    const aborted = new Promise<LocalStoreProbeResult[]>((resolve) => {
      onAbort = () => resolve([]);
      probeSignal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const work = Promise.resolve()
        .then(() => {
          probeSignal.throwIfAborted();
          return instance.probeLocalStores!({ signal: probeSignal });
        })
        .catch((): LocalStoreProbeResult[] => []);
      const result = await Promise.race([work, aborted]);
      return probeSignal.aborted ? [] : result;
    } finally {
      clearTimeout(timer);
      probeSignal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
}
