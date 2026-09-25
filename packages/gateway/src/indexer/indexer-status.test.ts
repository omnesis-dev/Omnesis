// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { IndexerStatusReporter } from "./indexer-status.js";
import type { IndexerWorkerProxy } from "../workers/indexer-worker-proxy.js";

// A stub proxy exposing only the `bootProgress` getter the reporter reads.
function proxyWithBootProgress(
  bootProgress: IndexerWorkerProxy["bootProgress"],
): IndexerWorkerProxy {
  return { bootProgress } as unknown as IndexerWorkerProxy;
}

describe("IndexerStatusReporter", () => {
  test("readiness defaults to spawning", () => {
    const r = new IndexerStatusReporter();
    expect(r.getReadiness()).toEqual({ status: "spawning" });
  });

  test("loading-model overlays the worker's live boot progress", () => {
    const r = new IndexerStatusReporter();
    r.setReadiness(
      { status: "loading-model", message: "warming up" },
      proxyWithBootProgress({ stage: "weights", progress: 0.42 }),
    );
    expect(r.getReadiness()).toEqual({
      status: "loading-model",
      message: "warming up",
      stage: "weights",
      progress: 0.42,
    });
  });

  test("loading-model without a proxy (or with no boot progress) returns as-is", () => {
    const r = new IndexerStatusReporter();
    r.setReadiness({ status: "loading-model", message: "warming up" });
    expect(r.getReadiness()).toEqual({ status: "loading-model", message: "warming up" });

    r.setReadiness({ status: "loading-model" }, proxyWithBootProgress(null));
    expect(r.getReadiness()).toEqual({ status: "loading-model" });
  });

  test("non-loading states never overlay boot progress, even with a proxy", () => {
    const r = new IndexerStatusReporter();
    r.setReadiness({ status: "ready" }, proxyWithBootProgress({ stage: "weights", progress: 0.9 }));
    expect(r.getReadiness()).toEqual({ status: "ready" });
  });

  test("setReadiness without a proxy clears any previously tracked proxy", () => {
    const r = new IndexerStatusReporter();
    r.setReadiness(
      { status: "loading-model" },
      proxyWithBootProgress({ stage: "weights", progress: 0.5 }),
    );
    // Re-enter loading-model with no proxy — the stale proxy must not leak in.
    r.setReadiness({ status: "loading-model" });
    expect(r.getReadiness()).toEqual({ status: "loading-model" });
  });
});
