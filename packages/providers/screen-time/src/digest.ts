// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash } from "@omnesis/core";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

/** Render a second count as a compact "2h 10m" / "45m" / "30s" string. */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/**
 * Build one searchable per-day digest document from a batch of
 * `screen_time_daily` rows (#4 / #450). Screen Time is otherwise pure-
 * structured — invisible to BM25 — so "how much did I use Chrome last week"
 * can only be answered via SQL. The digest doc puts the day's usage into prose
 * the search index can reach. One document per date in the batch.
 *
 * The doc↔rows relationship is 1-doc-to-many-rows (one date ⇄ many app rows),
 * so the 1:1 `boundDocument` edge does not apply; the searchability is the win.
 * A `boundDocumentMany` edge is future work.
 */
export function buildDailyDigests(
  records: Record<string, unknown>[],
  providerId: ProviderId,
  sourceId: SourceId,
): DocumentInput[] {
  const byDate = new Map<string, Array<{ app: string; total: number; sessions: number }>>();
  for (const r of records) {
    const date = String(r.date);
    const app = String(r.app_name ?? r.bundle_id ?? "Unknown app");
    const total = Number(r.total_seconds ?? 0);
    const sessions = Number(r.session_count ?? 0);
    const list = byDate.get(date);
    if (list) list.push({ app, total, sessions });
    else byDate.set(date, [{ app, total, sessions }]);
  }

  const docs: DocumentInput[] = [];
  for (const [date, apps] of byDate) {
    apps.sort((a, b) => b.total - a.total);
    const totalSeconds = apps.reduce((sum, a) => sum + a.total, 0);
    const lines = apps.map(
      (a) =>
        `- ${a.app}: ${formatDuration(a.total)} (${a.sessions} session${a.sessions === 1 ? "" : "s"})`,
    );
    const content = [
      `# Screen Time — ${date}`,
      "",
      `**Total:** ${formatDuration(totalSeconds)} across ${apps.length} app${apps.length === 1 ? "" : "s"}`,
      "",
      ...lines,
    ].join("\n");

    docs.push({
      providerId,
      sourceId,
      externalId: `screen-time-day:${date}`,
      title: `Screen Time — ${date}`,
      content,
      contentHash: computeContentHash(content),
      metadata: {
        documentType: "summary",
        // A per-day digest is a rolling aggregate: it is rewritten on every new
        // usage sample throughout the day. The generic marker routes it to the
        // background agent's daily batch instead of waking it per rewrite.
        rollingAggregate: true,
        people: [],
        tags: ["screen-time"],
        extra: { date },
      },
      sourceCreatedAt: `${date}T00:00:00.000Z`,
      sourceUpdatedAt: `${date}T00:00:00.000Z`,
    });
  }
  return docs;
}
