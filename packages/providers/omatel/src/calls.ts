// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash, countryNameToISO2, createLogger, normalizePhone } from "@omnesis/core";
import {
  cutoffMs,
  fingerprint,
  groupRows,
  planPage,
  storeUnavailablePage,
  utcDay,
  utcTime,
  type OmatelCursor,
} from "./group-sync.js";
import { OMATEL_CALL_LOG_TABLE } from "./schemas.js";
import { historyCoverage } from "./coverage.js";
import { CALLS_STORE, openStore } from "./store.js";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";
import type { StructuredSyncResult } from "@omnesis/source-sdk";

const log = createLogger("source:omatel-calls");

/** Bump when a day document's rendering changes, so every day renders again. */
export const CALLS_RENDER_VERSION = 1;

const PAGE_DAYS = 100;

/** One row of omatel's `calls` table. Times are epoch milliseconds, duration seconds. */
export interface CallRow {
  id: number;
  number: string;
  raw_number: string;
  direction: string;
  outcome: string;
  started_at: number;
  duration: number;
}

export interface CallsSyncOptions {
  dataDir: string;
  sourceId: SourceId;
  providerId: ProviderId;
  dataCutoff?: string;
  /** ISO 3166 region for numbers omatel could not normalize to E.164. */
  phoneRegion?: string;
}

/** How each omatel outcome reads in a day's list, and whether the call connected. */
const OUTCOMES: Record<string, { label: string; connected: boolean }> = {
  answered: { label: "", connected: true },
  missed: { label: "missed", connected: false },
  rejected: { label: "declined", connected: false },
  blocked: { label: "blocked", connected: false },
  unanswered: { label: "no answer", connected: false },
  failed: { label: "failed", connected: false },
};

function outcomeOf(row: CallRow): { label: string; connected: boolean } {
  return OUTCOMES[row.outcome] ?? { label: row.outcome, connected: false };
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** The peer's E.164 number: omatel's own normalization, else ours, else nothing. */
export function peerPhone(
  row: { number: string; raw_number: string },
  region?: string,
): string | undefined {
  const hint = countryNameToISO2(region);
  return normalizePhone(row.number, hint) ?? normalizePhone(row.raw_number, hint) ?? undefined;
}

export function readCalls(dataDir: string, dataCutoff?: string): CallRow[] | null {
  const db = openStore(dataDir, CALLS_STORE);
  if (!db) return null;
  try {
    return db
      .prepare(
        `SELECT id, number, raw_number, direction, outcome, started_at, duration
         FROM calls WHERE started_at >= ? ORDER BY started_at, id`,
      )
      .all(cutoffMs(dataCutoff)) as CallRow[];
  } finally {
    db.close();
  }
}

export function callToRecord(row: CallRow, region?: string): Record<string, unknown> {
  const phone = peerPhone(row, region);
  return {
    id: String(row.id),
    date: utcDay(row.started_at),
    time: new Date(row.started_at).toISOString(),
    direction: row.direction === "out" ? "outgoing" : "incoming",
    outcome: row.outcome,
    duration_seconds: row.duration,
    connected: outcomeOf(row).connected,
    counterparty: phone ?? (row.raw_number || row.number || "unknown"),
  };
}

export function buildCallDay(
  day: string,
  rows: readonly CallRow[],
  opts: Pick<CallsSyncOptions, "sourceId" | "providerId" | "phoneRegion">,
): DocumentInput {
  const people: PersonMention[] = [{ role: "participant", name: "You", isSelf: true }];
  const seen = new Set<string>();
  const lines: string[] = [];
  const calls: Record<string, unknown>[] = [];
  let talked = 0;
  for (const row of rows) {
    const outgoing = row.direction === "out";
    const { label, connected } = outcomeOf(row);
    const phone = peerPhone(row, opts.phoneRegion);
    const peer = phone ?? (row.raw_number || row.number || "Unknown");
    const qualifier = connected ? `, ${formatDuration(row.duration)}` : ` (${label})`;
    if (connected) talked += row.duration;
    lines.push(
      `- ${utcTime(row.started_at)} ${outgoing ? "Outgoing" : "Incoming"} call ${outgoing ? "→" : "←"} ${peer}${qualifier}`,
    );
    if (phone && !seen.has(phone)) {
      seen.add(phone);
      people.push({ role: "participant", phones: [phone] });
    }
    calls.push({
      time: new Date(row.started_at).toISOString(),
      direction: outgoing ? "outgoing" : "incoming",
      outcome: row.outcome,
      durationSeconds: row.duration,
      connected,
      peer: phone ?? null,
    });
  }
  const content = [
    `# Calls — ${day}`,
    "",
    `**Total:** ${rows.length} call${rows.length === 1 ? "" : "s"}, ${formatDuration(talked)}`,
    "",
    ...lines,
  ].join("\n");
  return {
    providerId: opts.providerId,
    sourceId: opts.sourceId,
    externalId: `call-log:${day}`,
    title: `Calls — ${day}`,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "call-log",
      // Rewritten whenever a call lands on this day: batch it with the day's
      // other rolling documents instead of waking the agent per edit.
      rollingAggregate: true,
      people,
      tags: [],
      extra: { date: day, callCount: rows.length, totalDurationSeconds: talked, calls },
    },
    sourceCreatedAt: `${day}T00:00:00.000Z`,
    sourceUpdatedAt: `${day}T23:59:59.999Z`,
  };
}

/**
 * One page of the call log: one `call-log` document per UTC day, rebuilt only
 * when that day's calls changed, and one `omatel_call_log` row per call.
 */
export function syncCalls(
  cursor: OmatelCursor | null,
  opts: CallsSyncOptions,
): StructuredSyncResult<OmatelCursor> {
  const rows = readCalls(opts.dataDir, opts.dataCutoff);
  if (rows === null) {
    return storeUnavailablePage(cursor, CALLS_RENDER_VERSION, CALLS_STORE.file, opts.dataCutoff);
  }
  const days = groupRows(rows, (row) => utcDay(row.started_at));
  const current = new Map(
    [...days].map(([day, dayRows]) => [day, fingerprint([opts.phoneRegion ?? null, dayRows])]),
  );
  const plan = planPage(cursor, current, CALLS_RENDER_VERSION, PAGE_DAYS);
  const documents = plan.render.map((day) => buildCallDay(day, days.get(day)!, opts));
  const records = plan.render.flatMap((day) =>
    days.get(day)!.map((row) => callToRecord(row, opts.phoneRegion)),
  );
  if (plan.render.length > 0 || plan.removed.length > 0) {
    log.info(
      `Call log page: ${plan.render.length} days rendered, ${plan.removed.length} removed, ${records.length} calls (hasMore: ${plan.hasMore})`,
    );
  }
  return {
    analytics: {
      tableName: OMATEL_CALL_LOG_TABLE,
      records,
      // The last page of every cycle names every call still in the store, so
      // a call the owner deleted leaves the table once enough snapshots agree.
      ...(plan.hasMore ? {} : { presentKeys: rows.map((row) => ({ id: String(row.id) })) }),
    },
    documents,
    deletedExternalIds: plan.removed.map((day) => `call-log:${day}`),
    cursor: plan.next,
    hasMore: plan.hasMore,
    // A complete read clears a withheld snapshot an unavailable store left.
    issues: plan.hasMore ? undefined : [],
    progress: {
      phase: cursor === null ? "bootstrap" : "incremental",
      processed: Object.keys(plan.next.groups).length,
      total: current.size,
      percentComplete:
        current.size > 0
          ? Math.round((Object.keys(plan.next.groups).length / current.size) * 100)
          : 100,
      ...historyCoverage(opts.dataCutoff),
    },
  };
}
