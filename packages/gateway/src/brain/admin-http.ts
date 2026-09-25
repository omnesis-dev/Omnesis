// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Thin façade for the operator Cognition HTTP surface.
 *
 * Resource-specific route registration lives in:
 * - `admin-http-loop-routes.ts`
 * - `admin-http-brief-routes.ts`
 * - `admin-http-run-routes.ts`
 * - `admin-http-transcript-routes.ts`
 * - `admin-http-list-routes.ts`
 * - `admin-http-sweep-routes.ts`
 *
 * Database and transcript reads are encapsulated by
 * `CognitionAdminQueryService`; this module preserves the original public
 * mount signature and composes the focused collaborators.
 */

import { NotFoundError } from "../http/errors.js";
import { mountCognitionBriefAdminRoutes } from "./admin-http-brief-routes.js";
import { mountCognitionListAdminRoutes } from "./admin-http-list-routes.js";
import { mountCognitionLoopAdminRoutes } from "./admin-http-loop-routes.js";
import { mountCognitionRunAdminRoutes } from "./admin-http-run-routes.js";
import { mountCognitionSweepAdminRoutes } from "./admin-http-sweep-routes.js";
import { mountCognitionTranscriptAdminRoutes } from "./admin-http-transcript-routes.js";
import { CognitionAdminQueryService } from "./cognition-admin-query-service.js";
import { CachedScanProbe } from "./bootstrap-status.js";
import type {
  BootstrapBacklog,
  BootstrapTimelineReader,
  BootstrapTimeline,
  BootstrapTimelineProbe,
  BootstrapBacklogReader,
  BootstrapSettingsView,
} from "./bootstrap-status.js";
import type { RunActivityReader } from "./cognition-admin-query-service.js";
import type { BriefsFeatureStatus } from "./feature-gate.js";
import type { SweepService } from "./sweeps/service.js";
import type { RouteApp } from "../http/routes/types.js";

/**
 * How long a backlog snapshot stands before it is recomputed.
 *
 * The count behind it takes seconds on a real corpus, and the quantity it
 * measures moves at the pace of a lane capped at a couple of hundred runs a
 * day — so a minute-old answer is not meaningfully worse than a live one, and
 * is two orders of magnitude cheaper to serve.
 */
const BOOTSTRAP_BACKLOG_TTL_MS = 60_000;
/**
 * The timeline changes shape only as the lane works, which is slow — minutes
 * between runs. A longer cache than the count's keeps a page refresh from
 * re-paying for a scan whose answer cannot have moved much.
 */
const BOOTSTRAP_TIMELINE_TTL_MS = 5 * 60_000;
import type Database from "better-sqlite3";
import type { CognitionBudgetSettings } from "./cognition/budget.js";

export type { RunActivityReader } from "./cognition-admin-query-service.js";

export interface MountBrainAdminRoutesOpts {
  db: Database.Database;
  writeGate: {
    wipeCognitionNotes(now: number): Promise<void>;
  };
  activity?: RunActivityReader | undefined;
  transcriptsDir?: string | undefined;
  clock?: (() => number) | undefined;
  getStatus?: (() => BriefsFeatureStatus) | undefined;
  /**
   * The sweep service. Omitted by storage-only tests and by any composition
   * that has no config directory — the authoring routes then simply are not
   * mounted, rather than being mounted onto a store that cannot exist.
   */
  sweeps?: SweepService | undefined;
  /** Whether `brain.sweepsEnabled` is on; defaults to reporting it off. */
  getSweepsEnabled?: (() => boolean) | undefined;
  /**
   * The resolved bootstrap knobs, read live. Absent compositions serve no lane
   * status rather than reporting defaults the engine may not be running under.
   */
  getBootstrapSettings?: (() => BootstrapSettingsView) | undefined;
  /**
   * The resolved budget ceilings, read live so raising one takes effect
   * without a restart — the same discipline the drainer reads them under.
   */
  getBudgetSettings?: (() => CognitionBudgetSettings) | undefined;
  /**
   * Record the operator's decision to begin the backfill, returning the start
   * instant. Idempotent — an already-started lane keeps its original.
   */
  startBootstrap?: ((now: number) => Promise<number>) | undefined;
  /**
   * The io worker, for the backlog probe. Absent compositions serve no backlog
   * rather than running a corpus scan on the main handle — which would freeze
   * the event loop, and with it the lane being observed.
   */
  io?: (BootstrapBacklogReader & BootstrapTimelineReader) | undefined;
}

export function mountBrainAdminRoutes(app: RouteApp, opts: MountBrainAdminRoutesOpts): void {
  const requireActive = (): void => {
    if (!opts.getStatus?.().active) throw new NotFoundError("Not found");
  };
  const requireVisible = (): void => {
    if (!opts.getStatus?.().visible) throw new NotFoundError("Not found");
  };
  const now = (): number => (opts.clock ?? Date.now)();
  const query = new CognitionAdminQueryService(
    opts.db,
    opts.transcriptsDir,
    opts.activity,
    // The mount happens at boot, so the injected clock's reading here is the
    // same origin the lane's own boot hold is measured from.
    now(),
  );
  const context = { app, query, requireActive, requireVisible, now };

  // One probe per mount, so the cache is shared across every caller rather
  // than per-request — two portal tabs must not each pay for the scan.
  const getSettings = opts.getBootstrapSettings;
  const io = opts.io;
  const backlogProbe =
    getSettings && io
      ? new CachedScanProbe<BootstrapBacklog>(
          () => query.bootstrapBacklog(io, { now, recencyWindowMs: getSettings().recencyWindowMs }),
          BOOTSTRAP_BACKLOG_TTL_MS,
          now,
        )
      : undefined;
  // The timeline is the same scan population grouped by month. A cache of its
  // own rather than a field on the backlog's, because the two are read at
  // different rates: the hero picture is drawn once on arriving at the page,
  // the count is re-read whenever the operator asks.
  const timelineProbe =
    getSettings && io
      ? new CachedScanProbe<BootstrapTimeline>(
          () =>
            query.bootstrapTimeline(io, { now, recencyWindowMs: getSettings().recencyWindowMs }),
          BOOTSTRAP_TIMELINE_TTL_MS,
          now,
        )
      : undefined;

  mountCognitionListAdminRoutes(context, {
    clock: opts.clock,
    writeGate: opts.writeGate,
    getBootstrapSettings: opts.getBootstrapSettings,
    getBudgetSettings: opts.getBudgetSettings,
    backlogProbe,
    timelineProbe,
    startBootstrap: opts.startBootstrap,
  });
  mountCognitionLoopAdminRoutes(context);
  mountCognitionRunAdminRoutes(context);
  mountCognitionTranscriptAdminRoutes(context);
  mountCognitionBriefAdminRoutes(context);
  if (opts.sweeps) {
    mountCognitionSweepAdminRoutes(context, {
      db: opts.db,
      sweeps: opts.sweeps,
      isLaneEnabled: opts.getSweepsEnabled ?? (() => false),
    });
  }
}
