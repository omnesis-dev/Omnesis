// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { syntheticEnabled } from "@omnesis/core";
import { scope } from "../../scope.js";
import { BadRequestError, NotFoundError, ServiceUnavailableError } from "../../errors.js";
import type { RouteApp } from "../types.js";
import type { AdminRoutesDeps } from "./internals.js";

const SYNTHETIC_PERIODIC_TASKS = new Set([
  "backfill.autoDetect",
  "backfill.mergeRulesEval",
  "backfill.interactionScoresRefresh",
  "backfill.peopleCountsRefresh",
  "backfill.linkBatch",
  "backfill.linkReconcile",
  "nearDup.inboxFlush",
  "backfill.nearDupDfRefresh",
  "backfill.nearDupCompute",
  // The absence sweep is the only path by which a snapshot omission becomes a
  // deletion; a synthetic E2E drives it deliberately rather than waiting out
  // its cadence.
  "absence.sweep",
]);

/**
 * Block 1.8 — operator observability.
 *
 *   GET  /admin/metrics
 *   GET  /admin/scheduler-metrics
 *   GET  /admin/background-jobs
 */
export function mountObservabilityRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  const { metrics, processVitals, scheduler, backgroundJobs, searchSnapshot } = deps;

  app.get("/admin/metrics", scope.admin(), (c) => {
    if (!metrics) {
      throw new ServiceUnavailableError("metrics registry not configured");
    }
    const windowStr = c.req.query("window");
    const windowSeconds = Math.max(10, Math.min(3600, Number(windowStr ?? 300) || 300));
    return c.json(metrics.snapshot(windowSeconds));
  });

  app.get("/admin/scheduler-metrics", scope.admin(), (c) => {
    if (!scheduler) {
      throw new ServiceUnavailableError("scheduler not configured");
    }
    const windowStr = c.req.query("window");
    const windowSeconds = Math.max(10, Math.min(3600, Number(windowStr ?? 300) || 300));
    return c.json(scheduler.snapshot(windowSeconds));
  });

  app.get("/admin/process-vitals", scope.admin(), (c) => {
    if (!processVitals) {
      throw new ServiceUnavailableError("process vitals not configured");
    }
    const windowStr = c.req.query("window");
    const windowSeconds = Math.max(10, Math.min(3600, Number(windowStr ?? 300) || 300));
    return c.json(processVitals.snapshot(windowSeconds));
  });

  // Pause / resume dispatch of background-priority scheduler tasks.
  // Used by the benchmark workflow to measure search latency without
  // backfill / link-extraction / merge-pass churn affecting the OS
  // page cache or the writer queue. User + realtime tasks continue
  // to dispatch normally — interactive HTTP requests, collector
  // ingestion, and auth flows still flow.
  //
  // Caller must remember to POST /admin/background/resume when
  // benchmarking is done; the gateway emits a startup log so a
  // forgotten pause is at least visible. For a fully isolated bench,
  // also stop the collector — `tmux send-keys -t 0:1.3 C-c` on the
  // standard tmux layout, or kill the collector process directly.
  app.post("/admin/background/pause", scope.admin(), (c) => {
    if (!scheduler) {
      throw new ServiceUnavailableError("scheduler not configured");
    }
    scheduler.pauseBackground();
    return c.json({ paused: scheduler.isBackgroundPaused() });
  });

  app.post("/admin/background/resume", scope.admin(), (c) => {
    if (!scheduler) {
      throw new ServiceUnavailableError("scheduler not configured");
    }
    scheduler.resumeBackground();
    return c.json({ paused: scheduler.isBackgroundPaused() });
  });

  app.get("/admin/background/status", scope.admin(), (c) => {
    if (!scheduler) {
      throw new ServiceUnavailableError("scheduler not configured");
    }
    return c.json({ paused: scheduler.isBackgroundPaused() });
  });

  // Synthetic-only deterministic test primitive. The allowlist avoids
  // turning every present and future periodic into an implicit mutation API.
  app.post("/admin/background/run/:taskName", scope.admin(), async (c) => {
    if (!syntheticEnabled()) throw new NotFoundError();
    if (!scheduler) {
      throw new ServiceUnavailableError("scheduler not configured");
    }
    const taskName = c.req.param("taskName");
    if (!SYNTHETIC_PERIODIC_TASKS.has(taskName)) {
      throw new BadRequestError("unsupported synthetic periodic task");
    }
    if (scheduler.isBackgroundPaused()) {
      throw new ServiceUnavailableError("background scheduler is paused");
    }
    const requestedTimeout = Number(c.req.query("timeoutMs"));
    const timeoutMs = Math.max(
      1,
      Math.min(120_000, Number.isFinite(requestedTimeout) ? requestedTimeout : 120_000),
    );
    const result = await scheduler.kickPeriodicAndWait(taskName, timeoutMs);
    return c.json({ result });
  });

  // Phase one of the synthetic E2E freeze: prevent new periodic roots while
  // leaving background dispatch enabled so descendants of in-flight roots can
  // finish. The test drains scheduler work before applying the hard pause.
  app.post("/admin/background/quiesce-periodics", scope.admin(), (c) => {
    if (!syntheticEnabled()) throw new NotFoundError();
    if (!scheduler) {
      throw new ServiceUnavailableError("scheduler not configured");
    }
    scheduler.quiescePeriodics();
    return c.json({ quiesced: true });
  });

  app.get("/admin/background-jobs", scope.admin(), (c) => {
    if (!backgroundJobs) {
      throw new ServiceUnavailableError("background-jobs registry not configured");
    }
    return c.json(backgroundJobs.snapshot());
  });

  // Search snapshot isolation — read-only view on `index.db` held in a
  // long-lived `BEGIN` so the per-connection page cache isn't blown by
  // concurrent indexer writes. Only mounted when
  // `search.snapshot.enabled` is true in `omnesis.json`.
  app.get("/admin/search-snapshot/status", scope.admin(), (c) => {
    if (!searchSnapshot) {
      throw new ServiceUnavailableError(
        "search snapshot isolation not enabled — set search.snapshot.enabled = true in omnesis.json",
      );
    }
    return c.json({ enabled: true, ...searchSnapshot.stats() });
  });

  app.post("/admin/search-snapshot/refresh", scope.admin(), async (c) => {
    if (!searchSnapshot) {
      throw new ServiceUnavailableError(
        "search snapshot isolation not enabled — set search.snapshot.enabled = true in omnesis.json",
      );
    }
    const durationMs = await searchSnapshot.refresh();
    return c.json({
      refreshedAt: Date.now(),
      durationMs,
      ...searchSnapshot.stats(),
    });
  });
}
