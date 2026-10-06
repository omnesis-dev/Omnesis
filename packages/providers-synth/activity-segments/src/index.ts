// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { defineStructuredSource, syncPage } from "@omnesis/source-sdk";
import { computeContentHash, localDayKey } from "@omnesis/core";
import {
  fakeLocalFlow,
  loadActiveUniverse,
  loadSourceFixtureJson,
  pageFromFixture,
  preDiscoveredAccounts,
  universeAccounts,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import { activitySegmentsIcon } from "./icons.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { DocumentInput, SourceId, ProviderId } from "@omnesis/types";
const instant = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const segmentSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["stationary", "walking", "running", "automotive", "cycling", "unknown"]),
    startTime: instant,
    endTime: instant,
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.endTime) > Date.parse(value.startTime) &&
      Date.parse(value.endTime) - Date.parse(value.startTime) <= 7 * 86_400_000,
    "Motion segments must have positive duration of at most seven days",
  );
export type SegmentFixture = z.infer<typeof segmentSchema>;
/** Mirrors iOS ActivitySegmentSchema.table; phones contribute partitioned streams. */
export const schema: AnalyticsTableSchema = {
  tableName: "activity_segments",
  displayName: "Activity Segments",
  description: "Closed intervals of motion observed on the phone",
  columns: [
    { name: "id", type: "VARCHAR", description: "Stable segment id" },
    { name: "account_id", type: "VARCHAR", description: "Per-phone account" },
    { name: "type", type: "VARCHAR", description: "Motion type" },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Start UTC" },
    { name: "end_time", type: "TIMESTAMPTZ", description: "End UTC" },
    { name: "duration_seconds", type: "INTEGER", description: "Duration" },
    { name: "confidence", type: "VARCHAR", description: "Observation confidence" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "start_time",
  record: { titleColumns: ["type"], keyColumns: ["type", "start_time", "duration_seconds"] },
};
export function loadSegments(): SegmentFixture[] {
  const entries = z
    .array(segmentSchema)
    .parse(
      loadSourceFixtureJson<unknown>(loadActiveUniverse(), "activity-segments", "segments.json"),
    );
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new Error("Synthetic motion repeats a segment id");
  return entries;
}
export function mapRecord(entry: SegmentFixture, accountId: string): Record<string, unknown> {
  return {
    id: entry.id,
    account_id: accountId,
    type: entry.type,
    start_time: entry.startTime,
    end_time: entry.endTime,
    duration_seconds: Math.round((Date.parse(entry.endTime) - Date.parse(entry.startTime)) / 1000),
    confidence: entry.confidence,
  };
}
export function mapDailyDocument(
  day: string,
  entries: SegmentFixture[],
  sourceId: SourceId,
  providerId: ProviderId,
): DocumentInput {
  const sorted = [...entries].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const title = `Movement — ${day}`;
  const content =
    title +
    " — " +
    sorted
      .map(
        (entry) =>
          `${entry.type} ${entry.startTime} → ${entry.endTime} (${mapRecord(entry, "").duration_seconds}s)`,
      )
      .join(" · ");
  return {
    sourceId,
    providerId,
    externalId: `activity-segments-day:${day}`,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "activity",
      tags: ["movement"],
      rollingAggregate: true,
      extra: {
        day,
        segments: sorted.map((entry) => ({
          type: entry.type,
          start: entry.startTime,
          end: entry.endTime,
          durationSeconds: mapRecord(entry, "").duration_seconds,
          confidence: entry.confidence,
        })),
      },
    },
    sourceCreatedAt: sorted[0]!.startTime,
    sourceUpdatedAt: sorted.at(-1)!.endTime,
  };
}
/** Split midnight crossings so each daily document describes only its own day. */
export function groupDays(
  entries: SegmentFixture[],
): Array<{ day: string; segments: SegmentFixture[] }> {
  const days = new Map<string, SegmentFixture[]>();
  for (const entry of entries) {
    let start = Date.parse(entry.startTime);
    const end = Date.parse(entry.endTime);
    while (start < end) {
      const date = new Date(start);
      const nextMidnight = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate() + 1,
      ).getTime();
      const pieceEnd = Math.min(nextMidnight, end);
      const day = localDayKey(start);
      const bucket = days.get(day) ?? [];
      bucket.push({
        ...entry,
        startTime: new Date(start).toISOString(),
        endTime: new Date(pieceEnd).toISOString(),
      });
      days.set(day, bucket);
      start = pieceEnd;
    }
  }
  return [...days]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, segments]) => ({ day, segments }));
}
export default defineStructuredSource<SynthCursor>({
  id: "activity-segments",
  name: "Activity Segments",
  description: "Closed motion intervals observed on the iPhone",
  authType: "local",
  unitName: "segments",
  primaryCount: "analytics",
  documentEventProfile: {
    documentTypes: ["activity"],
    personRoles: [],
    metadataFields: [
      {
        path: "tags",
        type: "string-array",
        description: "Movement tags attached to the daily motion aggregate.",
      },
    ],
  },
  singleInstance: true,
  multiDevice: { mode: "partitioned" },
  icon: activitySegmentsIcon,
  analyticsSchemas: [schema],
  discover: async () =>
    preDiscoveredAccounts("activity-segments", universeAccounts("activity-segments")),
  authFlow: async () =>
    fakeLocalFlow("activity-segments", universeAccounts("activity-segments")[0] ?? "synthetic-ios"),
  async create({ sourceId, providerId, accountId }) {
    const entries = loadSegments();
    const days = groupDays(entries);
    const rowsByDay = new Map<string, SegmentFixture[]>();
    for (const entry of entries) {
      const day = localDayKey(Date.parse(entry.startTime));
      const bucket = rowsByDay.get(day) ?? [];
      bucket.push(entry);
      rowsByDay.set(day, bucket);
    }
    return {
      analyticsSchemas: [schema],
      sync: async () => syncPage([], { offset: days.length }),
      async syncStructured(cursor) {
        const { batch, newCursor, hasMore, isFinalPage } = pageFromFixture(days, cursor);
        return {
          analytics: {
            tableName: schema.tableName,
            schema,
            records: batch.flatMap((item) =>
              (rowsByDay.get(item.day) ?? []).map((entry) => mapRecord(entry, accountId)),
            ),
            presentIds: isFinalPage ? entries.map((entry) => entry.id) : undefined,
          },
          documents: batch.map((item) =>
            mapDailyDocument(item.day, item.segments, sourceId, providerId),
          ),
          presentExternalIds: isFinalPage
            ? days.map((item) => `activity-segments-day:${item.day}`)
            : undefined,
          cursor: newCursor,
          hasMore,
        };
      },
    };
  },
});
