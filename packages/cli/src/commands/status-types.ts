// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// `sourceStats` and `indexStats` previously inlined the same field set as
// `SourceStats` and `IndexStats` in `@omnesis/core/gateway-client.ts`. Importing
// them keeps the CLI in sync when the wire shape evolves: a gateway-side change
// surfaces here as a compile error instead of a silent shape mismatch.
import type { SourceStats, IndexStats } from "@omnesis/source-sdk";
import type { ConfigHealth, FleetVersionSummary } from "@omnesis/core";
import type { SyncRemediation, SyncIssueStatus } from "@omnesis/types";

export interface StatusData {
  statuses: Array<{
    sourceId: string;
    providerId: string;
    sourceName: string;
    state: string;
    syncIntervalMs?: number;
    lastSyncAt?: string;
    lastError?: string;
    /**
     * What the operator has to do before `lastError` can clear, when the
     * collector reported the failure with one. Rendered in place of the raw
     * message, which stays available to `sources debug`.
     */
    remediation?: SyncRemediation;
    /**
     * Source-authored remediation sentence, present only when `state` is
     * `stale` — the source syncs fine but its local feed has stopped
     * delivering. Carries no error, so it is separate from `lastError`.
     */
    staleHint?: string;
    issues?: SyncIssueStatus[];
    progress?: {
      phase: string;
      total?: number;
      processed: number;
      percentComplete?: number;
    };
    lastSyncStats?: {
      documents: number;
      deleted: number;
      pages: number;
      durationMs: number;
    };
    unitName?: string;
    /** Descriptor's headline-count plane (#40); undefined → heuristic. */
    primaryCount?: "documents" | "analytics";
  }>;
  sourceStats?: Record<string, SourceStats>;
  analyticsRecordCounts?: Record<string, number>;
  dbSizeBytes?: number | null;
  /** Everything the gateway keeps on disk; absent from gateways that predate it. */
  diskUsageBytes?: number | null;
  indexStats?: IndexStats | null;
  timestamp: string;
  processVitals?: ProcessVitalsSnapshot | null;
  /**
   * Degraded (typo'd / dangling) inference role assignments reported by
   * `/status`. Null when an older gateway doesn't carry the field.
   */
  configHealth?: ConfigHealth | null;
  /** The gateway's own product version from `/health`; null when unreadable. */
  gatewayVersion?: string | null;
  /**
   * How the paired, non-revoked devices compare to that version. Null when
   * the device list could not be read — which is a different thing from an
   * install with no devices, and renders as no line rather than as zeros.
   */
  fleetVersions?: FleetVersionSummary | null;
}

export interface ProcessVitalsSnapshot {
  eventLoop?: { current: { p50Ms: number; p95Ms: number; p99Ms: number } | null };
  cpu?: {
    current: { userPct: number; systemPct: number; totalPct: number } | null;
    meanTotalPct: number;
  };
  memory?: { current: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number } | null };
  gc?: { windowCount: number; windowTotalMs: number };
}

// ── Gateway-driven status ──────────────────────────────────────────────────
//
// Status is assembled from several gateway endpoints in parallel:
//   - /admin/sources         registered sources (source of truth)
//   - /admin/sync/status     live per-source sync state
//   - /status                global doc counts + DB size
//   - /index/stats           per-source index breakdown
//   - /analytics/catalog     analytics record counts
//   - /documents/stats/:id   per-source date range + size (one call per source)
//
// Some legacy fields (lastSyncStats deltas and unitName) aren't
// on the gateway yet — they're rendered as "-" until SourceManager pushes
// richer telemetry through sync.status events.

export interface AdminSource {
  id: string;
  type: string;
  accountId: string;
  deviceId: string;
  config: { syncInterval?: string };
  enabled: boolean;
}
export interface SyncStatusEntry {
  issues?: SyncIssueStatus[];
  sourceId: string;
  /** Full provider ID `<providerType>:<accountId>` — used to group needs-auth rows. */
  providerId?: string;
  /**
   * Mirrors the gateway's `DisplaySyncState` over HTTP. `auth-expiring` and
   * `stale` are derived advisory overlays on a source that synced fine — the
   * renderer must not treat either as a failure.
   */
  state:
    | "idle"
    | "syncing"
    | "synced"
    | "error"
    | "paused"
    | "needs-auth"
    | "rate-limited"
    | "permission-degraded"
    | "background-access-missing"
    | "unavailable"
    | "auth-expiring"
    | "stale"
    | "removing";
  unitName?: string;
  /** Source-authored remediation sentence; present only when state is `stale`. */
  staleHint?: string;
  /** The structured remedy behind an `error`, when the failure named one. */
  remediation?: SyncRemediation;
  progress?: {
    phase?: string;
    total?: number;
    processed?: number;
    percentComplete?: number;
    message?: string;
  };
  startedAt?: number;
  /** ISO timestamp of the last successful cursor save (persisted, survives restart). */
  lastSyncAt: string | null;
  errorMessage?: string;
  erroredAt?: string;
}
