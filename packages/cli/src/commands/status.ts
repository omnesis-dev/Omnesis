// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hostname as osHostname } from "node:os";
import { defineCommand } from "citty";
import {
  PROTOCOL_VERSION,
  readPackageVersion,
  resolveToken,
  parseSourceKey,
  summarizeFleetVersions,
  websocketAuthProtocol,
  type ClientVersionState,
} from "@omnesis/core";
import {
  c,
  gatewayJson,
  buildCliFx,
  withSpinner,
  CliError,
  EXIT_AUTH,
  EXIT_GATEWAY_DOWN,
  GATEWAY_REQUEST_URL,
} from "../utils.js";
import { renderStatus } from "./status-render.js";
import type {
  StatusData,
  ProcessVitalsSnapshot,
  AdminSource,
  SyncStatusEntry,
} from "./status-types.js";

/** Product version of this CLI build, announced when it opens a socket. */
const CLI_VERSION = readPackageVersion(import.meta.url);

function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(s);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
  }
  return undefined;
}

async function fetchStatus(): Promise<StatusData> {
  const token = resolveToken();
  if (!token) throw new Error("No auth token. Start the gateway first or set OMNESIS_TOKEN.");

  // Auth errors (401/403) should be loud — an empty status table with no
  // hint about why is a nightmare to diagnose (stale OMNESIS_TOKEN overrides
  // ~/.config/omnesis/token silently). Other errors stay soft so partial
  // gateway outages don't break the whole command.
  const reportIfAuth = (path: string) => (err: Error) => {
    if (/Gateway 40[13]/.test(err.message)) {
      console.error(`${c.red}${path}: ${err.message}${c.reset}`);
      console.error(
        `${c.dim}Hint: check OMNESIS_TOKEN env var — it overrides ~/.config/omnesis/token.${c.reset}`,
      );
    }
    return { items: [] as AdminSource[], pendingRemovals: [] as Array<{ id: string }> };
  };
  const reportIfAuthStatuses = (path: string) => (err: Error) => {
    if (/Gateway 40[13]/.test(err.message)) {
      console.error(`${c.red}${path}: ${err.message}${c.reset}`);
      console.error(
        `${c.dim}Hint: check OMNESIS_TOKEN env var — it overrides ~/.config/omnesis/token.${c.reset}`,
      );
    }
    return { items: [] as SyncStatusEntry[] };
  };
  const [
    adminSources,
    syncStatus,
    overall,
    indexStats,
    analytics,
    descriptors,
    processVitals,
    health,
    devices,
  ] = await Promise.all([
    gatewayJson<{ items: AdminSource[]; pendingRemovals?: Array<{ id: string }> }>(
      "/admin/sources",
    ).catch(reportIfAuth("/admin/sources")),
    gatewayJson<{ items: SyncStatusEntry[] }>("/admin/sync/status").catch(
      reportIfAuthStatuses("/admin/sync/status"),
    ),
    gatewayJson<{
      documents?: { total: number; bySource: Record<string, number> };
      dbSizeBytes: number | null;
      diskUsage?: { totalBytes: number } | null;
      index?: unknown;
      configHealth?: StatusData["configHealth"];
    }>("/status").catch(() => ({}) as never),
    gatewayJson<StatusData["indexStats"]>("/index/stats").catch(() => null),
    gatewayJson<{ tables: Array<{ sourceId?: string; recordCount?: number }> }>(
      "/analytics/catalog",
    ).catch(() => ({ tables: [] })),
    // Descriptors carry the per-type headline-count plane (#40) and unit
    // noun — the latter is the fallback for gateway-internal sources (e.g.
    // `web`) that report no collector sync.status `unitName`.
    gatewayJson<{
      items: Array<{ id: string; unitName?: string; primaryCount?: "documents" | "analytics" }>;
    }>("/admin/source-descriptors").catch(() => ({ items: [] })),
    gatewayJson<ProcessVitalsSnapshot>("/admin/process-vitals?window=60").catch(() => null),
    // The gateway's own product version, and the fleet it serves — one line
    // under the table saying what this install is running and whether the
    // devices talking to it agree.
    gatewayJson<{ version?: string }>("/health").catch(() => null),
    gatewayJson<{
      items: Array<{ revokedAt?: number | null; versionState?: ClientVersionState }>;
    }>("/admin/devices").catch(() => null),
  ]);

  // type → descriptor signals used by the Count column.
  const descriptorByType = new Map(
    (descriptors.items ?? []).map((d) => [
      d.id,
      { unitName: d.unitName, primaryCount: d.primaryCount },
    ]),
  );

  // Union of source IDs from /admin/sources + /admin/sync/status (so even
  // older "discovered" sources show up).
  const ids = new Set<string>();
  for (const s of adminSources.items) ids.add(s.id);
  for (const s of syncStatus.items) ids.add(s.sourceId);
  // A source being removed is in neither set — its row is deleted and its sync
  // status cleared up front — while its documents are still on disk and still
  // counted by everything below. Without this it drops out of `status` the
  // instant removal starts, and the totals stop adding up.
  const removingIds = new Set((adminSources.pendingRemovals ?? []).map((r) => r.id));
  for (const id of removingIds) ids.add(id);

  const adminById = new Map(adminSources.items.map((s) => [s.id, s]));
  const syncById = new Map(syncStatus.items.map((s) => [s.sourceId, s]));

  // Per-source stats — one batch round-trip via `POST /documents/stats`
  // (was N+1 GETs against `/documents/stats/:id` previously).
  // Chunks at 100 ids to stay under the gateway's per-call cap.
  type SourceStatsRow = NonNullable<StatusData["sourceStats"]>[string];
  const allIds = Array.from(ids);
  const sourceStats: Record<string, SourceStatsRow> = {};
  const STATS_BATCH = 100;
  for (let i = 0; i < allIds.length; i += STATS_BATCH) {
    const chunk = allIds.slice(i, i + STATS_BATCH);
    try {
      const { stats } = await gatewayJson<{ stats: Record<string, SourceStatsRow> }>(
        "/documents/stats",
        {
          method: "POST",
          body: JSON.stringify({ sourceIds: chunk }),
        },
      );
      Object.assign(sourceStats, stats);
    } catch {
      // Gateway transient — fall back to no stats for this batch; the
      // per-source row renders zeros and the next refetch retries.
    }
  }

  // Analytics record counts — keyed by source type or full source id.
  const analyticsRecordCounts: Record<string, number> = {};
  for (const t of analytics.tables ?? []) {
    if (!t.sourceId || !t.recordCount) continue;
    analyticsRecordCounts[t.sourceId] = (analyticsRecordCounts[t.sourceId] ?? 0) + t.recordCount;
  }

  // Build status rows. The gateway has already collapsed in-memory + persisted
  // sync state into a canonical pill; we render whatever it gave us.
  const statuses = Array.from(ids).map((id) => {
    const adm = adminById.get(id);
    const sync = syncById.get(id);
    const { sourceType } = parseSourceKey(id);
    const descriptor = descriptorByType.get(sourceType);
    return {
      sourceId: id,
      // Prefer the gateway-reported providerId (`<providerType>:<accountId>`)
      // — falls back to source-type so legacy rows that haven't reported a
      // sync.status yet still get a stable group key.
      providerId: sync?.providerId ?? sourceType,
      sourceName: id,
      state: removingIds.has(id) ? "removing" : (sync?.state ?? "idle"),
      syncIntervalMs: parseDuration(adm?.config?.syncInterval),
      lastSyncAt: sync?.lastSyncAt ?? undefined,
      lastError: sync?.errorMessage,
      remediation: sync?.remediation,
      issues: sync?.issues,
      staleHint: sync?.staleHint,
      progress: sync?.progress
        ? {
            // Display reads the canonical SyncProgress fields directly —
            // they're already on the wire (collector → gateway → here).
            // The previous mapper translated to a fictional `{totalDocs,
            // processedDocs, percentage}` shape that nothing actually
            // wrote, so the bar stayed empty for every long bootstrap.
            phase: sync.progress.phase ?? sync.state,
            total: sync.progress.total,
            processed: sync.progress.processed ?? 0,
            percentComplete: sync.progress.percentComplete,
          }
        : undefined,
      lastSyncStats: undefined,
      unitName: sync?.unitName ?? descriptor?.unitName ?? "docs",
      primaryCount: descriptor?.primaryCount,
    };
  });

  // Always alphabetical by source ID. Keeping rows stable across
  // state transitions avoids the "row suddenly jumps to the top when
  // a sync kicks off" UX glitch, especially annoying in --watch.
  statuses.sort((a, b) => a.sourceId.localeCompare(b.sourceId));

  return {
    statuses,
    sourceStats,
    analyticsRecordCounts,
    dbSizeBytes: overall.dbSizeBytes ?? null,
    diskUsageBytes: overall.diskUsage?.totalBytes ?? null,
    indexStats: indexStats ?? null,
    processVitals: processVitals ?? null,
    configHealth: overall.configHealth ?? null,
    gatewayVersion: health?.version ?? null,
    // Revoked rows keep their history but run nothing, so they are not part
    // of the fleet this line reports on.
    fleetVersions: devices
      ? summarizeFleetVersions(
          devices.items
            .filter((d) => !d.revokedAt)
            .map((d) => d.versionState ?? ("unknown" as ClientVersionState)),
        )
      : null,
    timestamp: new Date().toISOString(),
  };
}

async function runOnce(): Promise<void> {
  try {
    const [data, fx] = await withSpinner("Loading status", () =>
      Promise.all([fetchStatus(), buildCliFx()]),
    );
    renderStatus(data, fx);
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err.message.includes("fetch") || err.message.includes("connect"))
    ) {
      throw new CliError(
        `Cannot reach gateway at ${GATEWAY_REQUEST_URL}. Is it running?`,
        EXIT_GATEWAY_DOWN,
      );
    }
    throw err;
  }
}

async function runWatch(): Promise<void> {
  const token = resolveToken();
  if (!token) {
    throw new CliError("No auth token. Start the gateway first or set OMNESIS_TOKEN.", EXIT_AUTH);
  }
  const wsAuthProtocol = websocketAuthProtocol(token);

  // Fetch initial data + terminal-FX context in parallel. fx is reused
  // across every render — source metadata is effectively static for a
  // process lifetime.
  const [initialData, fx] = await withSpinner("Loading status", () =>
    Promise.all([fetchStatus(), buildCliFx()]),
  );
  let lastData = initialData;
  let connected = false;
  let disconnectedAt: number | null = null;

  // Enter alternate screen buffer + hide cursor. Same trick top/less/vim
  // use. This gives us a clean slate that doesn't scroll the user's
  // existing terminal content off-screen, and — because subsequent
  // renders just move cursor-home and overwrite in place instead of
  // clearing — eliminates the clear-and-paint flicker.
  //
  // The individual `writeLine()` calls inside renderStatus append
  // `\x1b[K` before each newline so if the new row is shorter than the
  // old, the stale tail is wiped. After the whole render we write
  // `\x1b[0J` to clear any rows past the end (when the source list
  // itself shrinks between refreshes).
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[H");
  renderStatus(lastData, fx);
  process.stdout.write("\x1b[0J");

  // Restore terminal state on any exit path — Ctrl-C, SIGTERM, or a
  // clean early-return. Node's default SIGINT just aborts, which would
  // leave the cursor hidden + the alt screen active; that's a broken
  // terminal until the user `reset`s. Also tear down the watch loop's
  // resources so we don't leave WS handlers and timers strewn behind.
  let currentWs: WebSocket | null = null;
  let tickerInterval: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const teardownWatch = () => {
    if (tickerInterval) {
      clearInterval(tickerInterval);
      tickerInterval = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (currentWs) {
      // Detach the listeners explicitly so a final `close` event doesn't
      // re-enter `scheduleReconnect` after we've already been told to shut
      // down. Without this, an in-flight close that lands during teardown
      // would queue another reconnectTimer and keep the process alive.
      currentWs.onopen = null;
      currentWs.onmessage = null;
      currentWs.onerror = null;
      currentWs.onclose = null;
      try {
        currentWs.close();
      } catch {
        /* close on a half-open socket can throw; ignore */
      }
      currentWs = null;
    }
  };

  const restoreTty = () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  };
  process.on("SIGINT", () => {
    teardownWatch();
    restoreTty();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    teardownWatch();
    restoreTty();
    process.exit(143);
  });
  process.on("exit", restoreTty);

  const wsUrl = GATEWAY_REQUEST_URL.replace(/^http/, "ws") + "/device/ws";
  let fetching = false;

  // Exponential backoff for the reconnect loop: 1s → 2s → 4s → 8s → 16s →
  // 30s (cap). The previous fixed 3s tight-looped against an unreachable
  // gateway, hammering it on the way back up.
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30_000;
  let reconnectAttempts = 0;

  function renderCurrent() {
    // Move cursor home without clearing — each writeLine inside
    // renderStatus overwrites its row with \x1b[K to wipe tails; the
    // trailing \x1b[0J below handles rows that disappeared entirely.
    process.stdout.write("\x1b[H");
    if (!connected) {
      const ago = disconnectedAt ? Math.floor((Date.now() - disconnectedAt) / 1000) : 0;
      process.stdout.write(
        `${c.yellow}Gateway WS disconnected (${ago}s ago) — reconnecting...${c.reset}\x1b[K\n\n`,
      );
    }
    renderStatus(lastData, fx);
    process.stdout.write("\x1b[0J");
  }

  let pendingRefetch = false;

  async function refetchStatus() {
    if (fetching) {
      pendingRefetch = true;
      return;
    }
    fetching = true;
    try {
      lastData = await fetchStatus();
      renderCurrent();
    } catch {
      // Fetch may fail temporarily — ticker will re-render cached data
    }
    fetching = false;

    if (pendingRefetch) {
      pendingRefetch = false;
      refetchStatus();
    }
  }

  function connectWs() {
    // Detach handlers from any previous WebSocket before its reference is
    // overwritten — without this, an in-flight `close` event on the old
    // socket would re-enter scheduleReconnect after we already chained
    // forward, doubling the reconnect rate.
    if (currentWs) {
      currentWs.onopen = null;
      currentWs.onmessage = null;
      currentWs.onerror = null;
      currentWs.onclose = null;
    }
    const ws = new WebSocket(wsUrl, wsAuthProtocol);
    currentWs = ws;

    ws.onopen = () => {
      // The token was validated on the HTTP upgrade; the hello negotiates the
      // protocol and declares this build, so the gateway's version ledger
      // records the CLI like any other client rather than leaving it unknown.
      ws.send(
        JSON.stringify({
          kind: "command",
          id: crypto.randomUUID(),
          type: "hello",
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              hostname: osHostname(),
              platform: process.platform,
              version: CLI_VERSION,
            },
          },
        }),
      );
    };

    ws.onmessage = async (event) => {
      let envelope: { kind?: string; type?: string; ok?: boolean };
      try {
        envelope = JSON.parse(event.data as string);
      } catch {
        return;
      }

      // hello response
      if (envelope.kind === "response" && typeof envelope.ok === "boolean") {
        if (envelope.ok) {
          connected = true;
          disconnectedAt = null;
          reconnectAttempts = 0; // reset backoff on a successful handshake
          refetchStatus();
        }
        return;
      }

      // gateway events: refresh on anything that affects rendered status.
      if (envelope.kind === "event" && envelope.type) {
        if (envelope.type === "ping") return;
        if (
          envelope.type === "sync.status" ||
          envelope.type === "documents.upserted" ||
          envelope.type === "device.status"
        ) {
          refetchStatus();
        }
      }
    };

    ws.onerror = () => {
      // Suppress — onclose will handle reconnect
    };

    ws.onclose = () => {
      if (connected) {
        connected = false;
        disconnectedAt = Date.now();
        renderCurrent();
      }
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped). Sub-30s
    // cadences hammer the gateway during long outages; capping at 30s
    // keeps the user feedback loop tight when the gateway comes back.
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWs();
    }, delay);
  }

  connectWs();

  // 1-second ticker: re-renders time-ago values, polls every 5s as safety net.
  // Stored in `tickerInterval` so `teardownWatch()` can clear it on SIGINT/
  // SIGTERM — without that, the process kept ticking past the signal handler.
  let tickCount = 0;
  const POLL_INTERVAL_TICKS = 5;
  tickerInterval = setInterval(() => {
    tickCount++;
    if (fetching) return;
    if (tickCount % POLL_INTERVAL_TICKS === 0) {
      refetchStatus();
    } else {
      renderCurrent();
    }
  }, 1000);

  // Keep process alive
  await new Promise(() => {});
}

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show per-source sync + index state",
  },
  args: {
    watch: {
      type: "boolean",
      alias: "w",
      description: "live-update on gateway events (alt-screen UI)",
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run(ctx) {
    if (ctx.args.watch) {
      await runWatch();
    } else {
      await runOnce();
    }
  },
});
