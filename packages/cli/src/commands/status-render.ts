// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { formatFleetVersionSummary } from "@omnesis/core";
import {
  c,
  formatSize,
  formatTimeAgo,
  formatDateShort,
  formatInterval,
  iconFor,
  type CliFx,
} from "../utils.js";
import type { StatusData } from "./status-types.js";
import type { SyncRemediation } from "@omnesis/types";

// Per-line writer that clears to end of line before the newline. Used
// by both the one-shot render and the watch loop — for one-shot it's a
// harmless no-op (terminal is already blank past EOL), for watch it
// wipes the tail of any previous (longer) line at that row so we don't
// leak stale chars when values shorten between refreshes.
export function fmtMsCli(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

export function fmtPctCli(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function writeLine(s = ""): void {
  // `\x1b[K` is the "clear from cursor to end of line" escape, only useful
  // when we're rendering into a TTY in alt-screen / overwrite mode (the
  // watch loop). Stripping the bytes when stdout is piped to a file or
  // another process keeps the captured output clean and grep-able — the
  // bug was that a one-shot `omnesis status > out.txt` left `[K` after
  // every row.
  if (process.stdout.isTTY) {
    process.stdout.write(`${s}\x1b[K\n`);
  } else {
    process.stdout.write(`${s}\n`);
  }
}

/**
 * One remedy several sources may share, with the sources it covers. Keyed on
 * what the operator has to do — the summary and the executable — so the
 * Apple sources refused by one missing grant read as one job, not six.
 */
interface RemediationGroup {
  remediation: SyncRemediation;
  sourceIds: string[];
}

export function groupRemediations(
  statuses: ReadonlyArray<{ sourceId: string; state: string; remediation?: SyncRemediation }>,
): RemediationGroup[] {
  const groups = new Map<string, RemediationGroup>();
  for (const s of statuses) {
    if (s.state !== "error" || !s.remediation) continue;
    // PARITY:remediation-group-key — the portal groups by the same two fields.
    const key = `${s.remediation.summary}\u0000${s.remediation.executable ?? ""}`;
    const group = groups.get(key) ?? { remediation: s.remediation, sourceIds: [] };
    group.sourceIds.push(s.sourceId);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * The remedy as the lines `omnesis status` prints under the table: the
 * condition and the sources it costs, then the numbered steps, the executable
 * on its own line so it can be copied, and the restart.
 */
function renderRemediationLines(group: RemediationGroup): string[] {
  const { remediation, sourceIds } = group;
  const lines = [
    `  ${c.yellow}⚠ ${remediation.summary}${c.reset} ${c.dim}— ${sourceIds.join(", ")}${c.reset}`,
  ];
  const steps = [...remediation.steps];
  if (remediation.restartRequired) steps.push("Restart the collector.");
  steps.forEach((step, i) => lines.push(`    ${c.dim}${i + 1}.${c.reset} ${step}`));
  if (remediation.executable) {
    lines.push(`    ${c.dim}executable:${c.reset} ${c.cyan}${remediation.executable}${c.reset}`);
  }
  return lines;
}

export function renderStatus(data: StatusData, fx: CliFx): void {
  // Pre-compute needs-auth grouping so each row can show a sibling count.
  // Hint is rendered on every needs-auth row (no dedupe) so users scanning
  // any single row see the remediation immediately.
  const needsAuthByProvider = new Map<string, string[]>();
  for (const s of data.statuses) {
    if (s.state !== "needs-auth") continue;
    const key = s.providerId ?? s.sourceId;
    const list = needsAuthByProvider.get(key) ?? [];
    list.push(s.sourceId);
    needsAuthByProvider.set(key, list);
  }
  // A failure the operator has to act on names its remedy once under the
  // table; each row points at it with the summary and how many rows share it.
  const remediationGroups = groupRemediations(data.statuses);
  const remediationGroupSize = new Map<string, number>();
  for (const g of remediationGroups) {
    for (const id of g.sourceIds) remediationGroupSize.set(id, g.sourceIds.length);
  }

  const rows: Array<{
    icon: string;
    iconColor: string;
    name: string;
    state: string;
    stateColor: string;
    docs: string;
    docsPlain: string;
    indexed: string;
    size: string;
    lastSync: string;
    interval: string;
    ingestedRange: string;
    indexedRange: string;
    error?: string;
    /** The structured remedy behind `error`, rendered in place of it. */
    remediation?: SyncRemediation;
    /** How many rows share that remedy. */
    remediationGroupSize: number;
    /** Source-authored remediation sentence, rendered when state is `stale`. */
    staleHint?: string;
    issues?: import("@omnesis/types").SyncIssueStatus[];
    progress?: string;
    unitName: string;
    /** Group key for needs-auth grouping (= providerId). */
    providerKey?: string;
  }> = [];

  for (const s of data.statuses) {
    let icon: string, iconColor: string, stateColor: string;
    if (s.state === "paused") {
      icon = "⏸";
      iconColor = c.dim;
      stateColor = c.dim;
    } else if (s.state === "syncing") {
      icon = "⟳";
      iconColor = c.cyan;
      stateColor = c.cyan;
    } else if (s.state === "needs-auth") {
      // Distinct from generic error — credential failures are user-fixable
      // by re-running `cli -- add <slug>`. Yellow chip + remediation hint
      // line below makes it visually separable from a hard red error.
      icon = "⚠";
      iconColor = c.yellow;
      stateColor = c.yellow;
    } else if (s.state === "permission-degraded" || s.state === "background-access-missing") {
      icon = "⚠";
      iconColor = c.yellow;
      stateColor = c.yellow;
    } else if (s.state === "unavailable") {
      icon = "✗";
      iconColor = c.red;
      stateColor = c.red;
    } else if (s.state === "rate-limited") {
      // Deferred, self-healing — the provider asked us to back off. Blue
      // chip + retry note (rendered below) keeps it visually distinct from
      // both a hard red error and a yellow needs-auth.
      icon = "◷";
      iconColor = c.blue;
      stateColor = c.blue;
    } else if (s.state === "error") {
      icon = "✗";
      iconColor = c.red;
      stateColor = c.red;
    } else if (s.state === "stale") {
      // The source synced fine, but its local data feed has stopped delivering
      // — usually because the app that maintains it isn't running. Yellow, like
      // needs-auth: user-fixable guidance, not a failure. The source's own
      // remediation sentence renders on the line below.
      icon = "⚠";
      iconColor = c.yellow;
      stateColor = c.yellow;
    } else if (s.state === "auth-expiring") {
      // Still syncing; the credential lapses on a known future date.
      icon = "⚠";
      iconColor = c.yellow;
      stateColor = c.yellow;
    } else if (s.state === "removing") {
      // The source is already gone; what remains is deleting what it ingested.
      // Red because it is destructive and irreversible, not because it failed.
      icon = "⊘";
      iconColor = c.red;
      stateColor = c.red;
    } else if (s.state === "synced") {
      icon = "✓";
      iconColor = c.green;
      stateColor = c.green;
    } else {
      // "idle" — registered but never successfully synced. A state this
      // renderer doesn't know lands here too, and is shown under its own name
      // rather than relabelled: mislabelling an unrecognised state as `idle`
      // hides it, which is how a newly-added state goes unnoticed.
      icon = "·";
      iconColor = c.dim;
      stateColor = c.dim;
    }

    const stats = data.sourceStats?.[s.sourceId];
    const unit = s.unitName ?? "docs";
    // Choose the headline count. A source can override the heuristic via its
    // descriptor's `primaryCount` (#993):
    //   - "documents" → always the document total (e.g. `web`, whose tiny
    //     page_visits log must not shadow its page count).
    //   - "analytics" → always the analytics row count.
    // Otherwise the heuristic decides:
    //   1. `totalUnitCount` — when the source aggregates many units into each
    //      document (e.g. browser-history's daily digests sum visits via
    //      `extra.unitCount`). This is the user-meaningful number and
    //      must not be shadowed by a partial analytics table count.
    //   2. `analyticsRecordCount` — pure-structured sources (screen-time,
    //      strava) whose primary unit lives in DuckDB, not documents.
    //   3. `documentCount` — everything else (gmail, calendar, etc.).
    //
    // Why this order: the analytics catalog keys rows by source TYPE for
    // shared tables (e.g. `browser-history` for `browser_visits`, which
    // chrome + safari both write to), so a lookup by the full source id
    // `browser-history:chrome` misses the shared counts and surfaces only
    // the tiny per-browser tables (e.g. 4 search terms). `totalUnitCount`
    // is accurate per full source id because it comes from the gateway's
    // per-document metadata.
    const analyticsCount = data.analyticsRecordCounts?.[s.sourceId];
    const docCount = stats?.documentCount ?? 0;
    const heuristicCount =
      stats?.totalUnitCount && stats.totalUnitCount !== stats.documentCount
        ? stats.totalUnitCount
        : analyticsCount != null && analyticsCount > 0
          ? analyticsCount
          : docCount;
    const count =
      s.primaryCount === "documents"
        ? docCount
        : s.primaryCount === "analytics"
          ? analyticsCount != null && analyticsCount > 0
            ? analyticsCount
            : docCount
          : heuristicCount;
    // Build count string with delta from last sync
    let docsPlain = `${count.toLocaleString()} ${unit}`;
    let docs = docsPlain;
    if (s.lastSyncStats) {
      const parts: string[] = [];
      if (s.lastSyncStats.documents > 0) {
        parts.push(`${c.green}+${s.lastSyncStats.documents}${c.reset}`);
      }
      if (s.lastSyncStats.deleted > 0) {
        parts.push(`${c.red}-${s.lastSyncStats.deleted}${c.reset}`);
      }
      if (parts.length > 0) {
        const deltaSuffix = ` (${parts.join("/")})`;
        const deltaPlain = deltaSuffix.replace(/\x1b\[[0-9;]*m/g, "");
        docs += deltaSuffix;
        docsPlain += deltaPlain;
      }
    }

    const size = stats ? formatSize(stats.dataSizeBytes) : "-";
    const lastSync = s.lastSyncAt ? formatTimeAgo(s.lastSyncAt) : "-";
    const interval = s.syncIntervalMs ? formatInterval(s.syncIntervalMs) : "-";

    let ingestedRange = "-";
    if (stats?.earliestSourceDate && stats?.latestSourceDate) {
      ingestedRange = `${formatDateShort(stats.earliestSourceDate)}-${formatDateShort(stats.latestSourceDate)}`;
    }

    const idxInfo = data.indexStats?.bySource?.[s.sourceId];
    let indexedRange = "-";
    if (idxInfo?.earliestIndexedDate && idxInfo?.latestIndexedDate) {
      indexedRange = `${formatDateShort(idxInfo.earliestIndexedDate)}-${formatDateShort(idxInfo.latestIndexedDate)}`;
    }

    const displayName = s.sourceId;

    let progress: string | undefined;
    if (s.progress && (s.progress.processed > 0 || s.progress.total !== undefined)) {
      // When the source knows its total (Gmail's messagesTotal, etc.) show
      // "processed/total (pct%)". When the total is unknown — which is the
      // case for iOS Apple Health, Notion pagination, and anything else
      // that pages without an upfront count — show just the processed
      // count, and only when it's > 0 (a bare "0" at sync start is noise).
      if (s.progress.total !== undefined && s.progress.percentComplete !== undefined) {
        progress = `${s.progress.processed}/${s.progress.total} (${s.progress.percentComplete}%)`;
      } else if (s.progress.processed > 0) {
        progress = `${s.progress.processed} processed`;
      }
    }

    // Indexing percentage (capped at 100%)
    let indexed = "-";
    if (idxInfo && idxInfo.gatewayDocs > 0) {
      indexed = `${Math.min(idxInfo.percentIndexed, 100)}%`;
    } else if (data.indexStats && !data.indexStats.enabled) {
      indexed = "-";
    }

    rows.push({
      icon,
      iconColor,
      stateColor,
      name: displayName,
      state: s.state,
      docs,
      docsPlain,
      indexed,
      size,
      lastSync,
      interval,
      ingestedRange,
      indexedRange,
      error: s.lastError,
      remediation: s.remediation,
      remediationGroupSize: remediationGroupSize.get(s.sourceId) ?? 1,
      staleHint: s.staleHint,
      issues: s.issues,
      progress,
      unitName: unit,
      providerKey: s.providerId,
    });
  }

  // Compute column widths (docsW uses plain text length, not ANSI)
  const nameW = Math.max(6, ...rows.map((r) => r.name.length));
  const stateW = Math.max(
    7,
    ...rows.map((r) => {
      if (r.progress) {
        return r.progress.length;
      }
      return r.state.length;
    }),
  );
  const docsW = Math.max(5, ...rows.map((r) => r.docsPlain.length));
  const idxW = Math.max(3, ...rows.map((r) => r.indexed.length));
  const sizeW = Math.max(4, ...rows.map((r) => r.size.length));
  const syncW = Math.max(6, ...rows.map((r) => r.lastSync.length));
  const intW = Math.max(3, ...rows.map((r) => r.interval.length));
  const ingRangeW = Math.max(14, ...rows.map((r) => r.ingestedRange.length));
  const idxRangeW = Math.max(13, ...rows.map((r) => r.indexedRange.length));

  // Header
  const dbInfo = data.diskUsageBytes
    ? ` ${c.dim}(on disk: ${formatSize(data.diskUsageBytes)})${c.reset}`
    : data.dbSizeBytes
      ? ` ${c.dim}(DB: ${formatSize(data.dbSizeBytes)})${c.reset}`
      : "";
  writeLine();
  writeLine(`${c.bold}Omnesis Status${c.reset}${dbInfo}`);
  writeLine();

  // When inline icons are rendering, each data row has a 3-cell prefix
  // (2-cell image + 1 space) after the status symbol. Reserve the same
  // space in the header + separator so columns align visually.
  const iconColPad = fx.images ? "   " : "";

  const header =
    `  ` +
    `${iconColPad}` +
    `${"Source".padEnd(nameW)}  ` +
    `${"State".padEnd(stateW)}  ` +
    `${"Count".padEnd(docsW)}  ` +
    `${"Idx".padStart(idxW)}  ` +
    `${"Size".padStart(sizeW)}  ` +
    `${"Synced".padEnd(syncW)}  ` +
    `${"Int".padEnd(intW)}  ` +
    `${"Ingested Range".padEnd(ingRangeW)}  ` +
    `Indexed Range`;
  writeLine(`${c.dim}${header}${c.reset}`);
  const totalW =
    2 +
    iconColPad.length +
    nameW +
    2 +
    stateW +
    2 +
    docsW +
    2 +
    idxW +
    2 +
    sizeW +
    2 +
    syncW +
    2 +
    intW +
    2 +
    ingRangeW +
    2 +
    idxRangeW;
  writeLine(`${c.dim}${"─".repeat(totalW)}${c.reset}`);

  for (const row of rows) {
    let stateStr: string;
    if (row.progress) {
      stateStr = `${row.stateColor}${row.progress.padEnd(stateW)}${c.reset}`;
    } else {
      stateStr = `${row.stateColor}${row.state.padEnd(stateW)}${c.reset}`;
    }

    // Color the indexed percentage
    const idxColor = row.indexed === "100%" ? c.green : row.indexed === "-" ? c.dim : c.yellow;

    // Pad docs left-aligned using plain text length (ANSI codes don't count)
    const docsPadded = row.docs + " ".repeat(Math.max(0, docsW - row.docsPlain.length));

    // Source icon (renders inline in iTerm2 / Kitty, empty string
    // elsewhere — padding stays consistent because every row gets
    // the same treatment). Placed between the status symbol and the
    // source ID.
    const srcIcon = iconFor(row.name, fx);
    const srcIconPrefix = srcIcon ? `${srcIcon} ` : "";

    const rowLine =
      `${row.iconColor}${row.icon}${c.reset} ` +
      `${srcIconPrefix}` +
      `${row.name.padEnd(nameW)}  ` +
      `${stateStr}  ` +
      `${docsPadded}  ` +
      `${idxColor}${row.indexed.padStart(idxW)}${c.reset}  ` +
      `${c.dim}${row.size.padStart(sizeW)}${c.reset}  ` +
      `${row.lastSync.padEnd(syncW)}  ` +
      `${c.dim}${row.interval.padEnd(intW)}${c.reset}  ` +
      `${c.dim}${row.ingestedRange.padEnd(ingRangeW)}${c.reset}  ` +
      `${c.dim}${row.indexedRange}${c.reset}`;
    writeLine(rowLine);

    if (row.error) {
      // needs-auth errors carry a `needs reauth: ` prefix that's an
      // implementation detail. Strip it and render the hint in yellow
      // so it reads as guidance, not as a hard failure.
      const NEEDS_AUTH_PREFIX = "needs reauth: ";
      // rate-limited deferrals carry a `rate-limited: ` prefix — same idea,
      // rendered in blue so the back-off note reads as transient, not failure.
      const RATE_LIMITED_PREFIX = "rate-limited: ";
      if (row.state === "needs-auth" && row.error.startsWith(NEEDS_AUTH_PREFIX)) {
        const groupKey = row.providerKey ?? row.name;
        const hint = row.error.slice(NEEDS_AUTH_PREFIX.length);
        const groupSize = needsAuthByProvider.get(groupKey)?.length ?? 1;
        const suffix = groupSize > 1 ? ` (${groupSize} sources affected)` : "";
        writeLine(`  ${iconColPad}${"".padEnd(nameW + 2)}${c.yellow}↳ ${hint}${suffix}${c.reset}`);
      } else if (row.state === "rate-limited") {
        const hint = row.error.startsWith(RATE_LIMITED_PREFIX)
          ? row.error.slice(RATE_LIMITED_PREFIX.length)
          : row.error;
        writeLine(`  ${iconColPad}${"".padEnd(nameW + 2)}${c.blue}↳ ${hint}${c.reset}`);
      } else if (row.state === "error" && row.remediation) {
        // The remedy stands in for the message; the steps are printed once
        // under the table, and the raw message stays with `sources debug`.
        const suffix =
          row.remediationGroupSize > 1 ? ` (${row.remediationGroupSize} sources affected)` : "";
        writeLine(
          `  ${iconColPad}${"".padEnd(nameW + 2)}${c.yellow}↳ ${row.remediation.summary}${suffix} — see below${c.reset}`,
        );
      } else {
        writeLine(`  ${iconColPad}${"".padEnd(nameW + 2)}${c.red}${row.error}${c.reset}`);
      }
    }

    // A stalled feed carries no error — it is a healthy sync with nothing to
    // show for it — so its hint hangs off `staleHint`, not the error branch.
    if (row.state === "stale" && row.staleHint) {
      writeLine(`  ${iconColPad}${"".padEnd(nameW + 2)}${c.yellow}↳ ${row.staleHint}${c.reset}`);
    }
    for (const issue of row.issues ?? []) {
      writeLine(
        `  ${iconColPad}${"".padEnd(nameW + 2)}${c.yellow}⚠ ${issue.message} (since ${new Date(issue.since).toISOString()})${c.reset}`,
      );
      if (issue.remediation)
        writeLine(
          `  ${iconColPad}${"".padEnd(nameW + 2)}${c.dim}${issue.remediation.steps.join(" ")}${c.reset}`,
        );
    }
  }

  if (remediationGroups.length > 0) {
    writeLine();
    writeLine(`${c.bold}Access Required${c.reset}`);
    for (const group of remediationGroups) {
      for (const line of renderRemediationLines(group)) writeLine(line);
    }
  }

  // Index migration (epic #1011): a graceful double-buffered embedder swap is
  // rebuilding a new generation in the background. The per-source Idx column
  // above keeps reading the ACTIVE generation (search is live and complete on
  // the old model); this line surfaces the migration as separate, clearly-
  // labeled background progress so it reads as an upgrade-in-flight, not a loss
  // of the existing index. When there is no complete active generation (a first
  // build, or a hard cutover that abandoned the old index), the build IS the
  // primary search readiness, so the framing flips to "semantic search limited".
  const building = data.indexStats?.indexVersions?.building;
  if (building) {
    const active = data.indexStats?.indexVersions?.active;
    const progress = `${building.percent}% (${building.docsBuilt}/${building.docsTotal} docs)`;
    writeLine();
    if (active) {
      writeLine(`${c.bold}Index Migration${c.reset}`);
      writeLine(
        `  ${c.yellow}↳${c.reset} migrating to ${c.cyan}${building.embedModel}${c.reset} ${c.dim}${progress}${c.reset}`,
      );
      writeLine(
        `  ${c.dim}  search live on ${active.embedModel} — switches automatically when ready${c.reset}`,
      );
    } else {
      writeLine(`${c.bold}Index Build${c.reset}`);
      writeLine(
        `  ${c.yellow}↳${c.reset} building ${c.cyan}${building.embedModel}${c.reset} ${c.dim}${progress}${c.reset}`,
      );
      writeLine(`  ${c.dim}  semantic search limited until the build completes${c.reset}`);
    }
  }

  // Config health — degraded (typo'd / dangling) inference role assignments.
  // Fail-loud: a capability silently disabled by a bad assignment surfaces
  // here as a named red line saying which role and why, instead of hiding in
  // the gateway log. An intentionally-unset role is a normal state and never
  // appears (the gateway never reports it as degraded).
  const degraded = data.configHealth?.degradedRoles ?? [];
  if (degraded.length > 0) {
    writeLine();
    writeLine(`${c.bold}${c.red}Inference Config Degraded${c.reset}`);
    for (const d of degraded) {
      writeLine(`  ${c.red}✗ ${d.role}${c.reset}  ${c.dim}${d.reason}${c.reset}`);
    }
  }

  // Process vitals (graceful degradation — older gateways won't have the endpoint)
  if (data.processVitals) {
    const pv = data.processVitals;
    writeLine();
    writeLine(`${c.bold}Process Health${c.reset} ${c.dim}(1 min window)${c.reset}`);
    const el = pv.eventLoop?.current;
    if (el) {
      writeLine(
        `  ${c.dim}Event loop${c.reset}   p50=${fmtMsCli(el.p50Ms)}  p95=${fmtMsCli(el.p95Ms)}  p99=${fmtMsCli(el.p99Ms)}`,
      );
    }
    const cpu = pv.cpu?.current;
    if (cpu) {
      writeLine(
        `  ${c.dim}CPU${c.reset}          user=${fmtPctCli(cpu.userPct)}  system=${fmtPctCli(cpu.systemPct)}  total=${fmtPctCli(cpu.totalPct)}`,
      );
    }
    const mem = pv.memory?.current;
    if (mem) {
      writeLine(
        `  ${c.dim}Memory${c.reset}       rss=${formatSize(mem.rssBytes)}  heap=${formatSize(mem.heapUsedBytes)}/${formatSize(mem.heapTotalBytes)}`,
      );
    }
    const gc = pv.gc;
    if (gc && gc.windowCount > 0) {
      writeLine(
        `  ${c.dim}GC pauses${c.reset}    ${gc.windowCount} pauses  total=${fmtMsCli(gc.windowTotalMs)}`,
      );
    }
  }

  // What this install is running, and whether the devices talking to it
  // agree. `unsupported` is the only count that is coloured: a lagging app
  // build is the normal consequence of a store release trailing the tag.
  if (data.gatewayVersion || data.fleetVersions) {
    writeLine();
    const parts: string[] = [];
    if (data.gatewayVersion) parts.push(`${c.bold}Gateway${c.reset} ${data.gatewayVersion}`);
    if (data.fleetVersions) {
      const fleet = data.fleetVersions;
      const summary = formatFleetVersionSummary(fleet);
      parts.push(
        fleet.unsupported > 0
          ? `${c.dim}devices:${c.reset} ${c.red}${summary}${c.reset}`
          : `${c.dim}devices:${c.reset} ${c.dim}${summary}${c.reset}`,
      );
    }
    writeLine(parts.join(`  ${c.dim}·${c.reset}  `));
  }

  writeLine();
}
