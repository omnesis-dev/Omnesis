// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineStructuredSource, syncPage } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import {
  ALL_HEALTH_SCHEMAS,
  HEALTH_BODY,
  HEALTH_ACTIVITY,
  HEALTH_VITALS,
  HEALTH_NUTRITION,
  HEALTH_ENVIRONMENT,
  HEALTH_SLEEP,
  HEALTH_MINDFUL,
  HEALTH_MOOD,
  HEALTH_WORKOUTS,
} from "./schemas.js";
import {
  bodyRecords,
  activityRecords,
  vitalsRecords,
  nutritionRecords,
  environmentRecords,
  sleepRecords,
  mindfulRecords,
  moodRecords,
  workoutRecords,
  selfAccountId,
} from "./fixtures.js";
import { appleHealthIconDataUri } from "./icons.js";
import type { StructuredSyncResult, AnalyticsTableSchema } from "@omnesis/source-sdk";

/**
 * Synth Apple Health.
 *
 * Mirrors the iOS source's analytics shape exactly — same 9 tables, same
 * column types, same primary keys. Drains in a state-machine cursor (one
 * category per page) so the gateway's structured-ingest path is exercised
 * page-by-page just like the real iOS flow.
 *
 * `pushBased` is INTENTIONALLY OFF: the real iOS source is push-only and
 * the desktop collector never polls it. For the synthetic gateway, we want
 * the records to actually land on first sync, so this acts like a normal
 * structured source whose `syncStructured()` returns one category per call.
 */

interface Cursor extends SynthCursor {
  phase?:
    | "body"
    | "activity"
    | "vitals"
    | "sleep"
    | "nutrition"
    | "mindful"
    | "mood"
    | "environment"
    | "workouts"
    | "done";
}

const PHASES: Array<{
  phase: NonNullable<Cursor["phase"]>;
  next: NonNullable<Cursor["phase"]>;
  schema: AnalyticsTableSchema;
  load: () => readonly object[];
}> = [
  { phase: "body", next: "activity", schema: HEALTH_BODY, load: bodyRecords },
  { phase: "activity", next: "vitals", schema: HEALTH_ACTIVITY, load: activityRecords },
  { phase: "vitals", next: "sleep", schema: HEALTH_VITALS, load: vitalsRecords },
  { phase: "sleep", next: "nutrition", schema: HEALTH_SLEEP, load: sleepRecords },
  { phase: "nutrition", next: "mindful", schema: HEALTH_NUTRITION, load: nutritionRecords },
  { phase: "mindful", next: "mood", schema: HEALTH_MINDFUL, load: mindfulRecords },
  { phase: "mood", next: "environment", schema: HEALTH_MOOD, load: moodRecords },
  { phase: "environment", next: "workouts", schema: HEALTH_ENVIRONMENT, load: environmentRecords },
  { phase: "workouts", next: "done", schema: HEALTH_WORKOUTS, load: workoutRecords },
];

const accountId = selfAccountId();

export default defineStructuredSource<Cursor>({
  id: "apple-health",
  name: "Apple Health",
  description: "Health and activity metrics from Apple Health (HealthKit)",
  authType: "local",
  unitName: "samples",
  singleInstance: true,
  icon: { sfSymbol: "heart.fill", color: "#FF2D55", imageDataUri: appleHealthIconDataUri },
  // The Apple Health account id is the per-iPhone pairing identifier
  // (e.g. `local`). Declaring the self-identity hook lets the gateway pair
  // health documents to the self person via the LID `apple-health-account:
  // <account>` without naming "apple-health" in shared code. No account
  // pattern — every Health account is the user's own. (Apple Health has no
  // real collector package — the iOS app pushes its data; this synth twin
  // carries the hook so test/synthetic flows exercise it. The production
  // iOS push of the hook is tracked alongside the other native-host work.)
  selfIdentity: { aliasPrefix: "apple-health-account" },
  analyticsSchemas: ALL_HEALTH_SCHEMAS,
  discover: async () => preDiscoveredAccounts("apple-health", [accountId]),
  authFlow: async () => fakeLocalFlow("apple-health", accountId),
  async create() {
    return {
      analyticsSchemas: ALL_HEALTH_SCHEMAS,
      async sync() {
        // Unstructured side is empty — health is pure analytics. Returning a
        // no-op SyncResult keeps the sync engine's branch logic happy.
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
