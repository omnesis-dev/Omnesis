// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineStructuredSource, syncPage } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import {
  ALL_HEALTH_CONNECT_SCHEMAS,
  HC_BODY,
  HC_ACTIVITY,
  HC_VITALS,
  HC_NUTRITION,
  HC_SLEEP,
  HC_MINDFULNESS,
  HC_EXERCISE,
  HC_CYCLE,
} from "./schemas.js";
import {
  bodyRecords,
  activityRecords,
  vitalsRecords,
  nutritionRecords,
  sleepRecords,
  mindfulnessRecords,
  exerciseRecords,
  cycleRecords,
  selfAccountId,
} from "./fixtures.js";
import { healthConnectIconDataUri } from "./icons.js";
import type { StructuredSyncResult, AnalyticsTableSchema } from "@omnesis/source-sdk";

/**
 * Synth Health Connect.
 *
 * The real source is Android (Kotlin) reading Android Health Connect and pushing
 * to /analytics/ingest over the device WS — the Android analogue of how iOS hosts
 * Apple Health. This synthetic twin mirrors that source's analytics shape exactly
 * (the same 8 `hc_*` tables / columns / primary keys) so the gateway, portal,
 * agent, and SQL surfaces render it generically and the structured E2E proves the
 * round trip without a device.
 *
 * Drains in a state-machine cursor (one table per page), like the real per-type
 * rotation. `pushBased` is intentionally OFF so records land on first sync in the
 * synthetic gateway.
 */

interface Cursor extends SynthCursor {
  phase?:
    | "body"
    | "activity"
    | "vitals"
    | "sleep"
    | "nutrition"
    | "mindfulness"
    | "exercise"
    | "cycle"
    | "done";
}

const PHASES: Array<{
  phase: NonNullable<Cursor["phase"]>;
  next: NonNullable<Cursor["phase"]>;
  schema: AnalyticsTableSchema;
  load: () => readonly object[];
}> = [
  { phase: "body", next: "activity", schema: HC_BODY, load: bodyRecords },
  { phase: "activity", next: "vitals", schema: HC_ACTIVITY, load: activityRecords },
  { phase: "vitals", next: "sleep", schema: HC_VITALS, load: vitalsRecords },
  { phase: "sleep", next: "nutrition", schema: HC_SLEEP, load: sleepRecords },
  { phase: "nutrition", next: "mindfulness", schema: HC_NUTRITION, load: nutritionRecords },
  { phase: "mindfulness", next: "exercise", schema: HC_MINDFULNESS, load: mindfulnessRecords },
  { phase: "exercise", next: "cycle", schema: HC_EXERCISE, load: exerciseRecords },
  { phase: "cycle", next: "done", schema: HC_CYCLE, load: cycleRecords },
];

const accountId = selfAccountId();

export default defineStructuredSource<Cursor>({
  id: "health-connect",
  name: "Health Connect",
  description: "Health and activity metrics from Android Health Connect",
  authType: "local",
  unitName: "samples",
  singleInstance: true,
  icon: {
    sfSymbol: "heart.text.square.fill",
    color: "#3DDC84",
    imageDataUri: healthConnectIconDataUri,
  },
  analyticsSchemas: ALL_HEALTH_CONNECT_SCHEMAS,
  discover: async () => preDiscoveredAccounts("health-connect", [accountId]),
  authFlow: async () => fakeLocalFlow("health-connect", accountId),
  async create() {
    return {
      analyticsSchemas: ALL_HEALTH_CONNECT_SCHEMAS,
      async sync() {
        // Unstructured side is empty — health is pure analytics.
        return syncPage([], { phase: "done" } as Cursor, { hasMore: false });
      },
      async syncStructured(cursor): Promise<StructuredSyncResult<Cursor>> {
        const phase = (cursor?.phase as Cursor["phase"]) ?? "body";
        if (phase === "done") {
          return { cursor: { phase: "done" }, hasMore: false };
        }
        const stage = PHASES.find((p) => p.phase === phase)!;
        const records = stage.load() as unknown as Record<string, unknown>[];
        return {
          analytics: { tableName: stage.schema.tableName, records, schema: stage.schema },
          cursor: { phase: stage.next },
          hasMore: stage.next !== "done",
        };
      },
    };
  },
});
