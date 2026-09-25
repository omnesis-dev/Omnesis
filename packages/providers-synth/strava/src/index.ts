// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realStrava from "@omnesis/provider-strava";
import { defineProvider, syncPage } from "@omnesis/source-sdk";
import {
  fakeOAuthFlow,
  preDiscoveredAccounts,
  selfAccountId,
  type SynthCursor,
  impairedSnapshot,
} from "@omnesis/providers-synth-common";
import {
  loadActivities,
  loadZones,
  mapActivity,
  mapActivityRecord,
  mapZoneRecord,
} from "./fixtures.js";
import type { AnalyticsTableSchema, StructuredSyncResult } from "@omnesis/source-sdk";

const { type: _type, ...rest } = realStrava;
const accountId = selfAccountId("extra", "stravaAthleteId");

// Pull the two table schemas the synth populates out of the real source's
// declared `analyticsSchemas` so they stay in lockstep with the real
// provider (column names, primary keys, etc.). Declaring all ~13 schemas
// here would create empty DuckDB tables the synth never fills, which
// silently breaks any agent query that joins on them.
const realActivitiesSource = rest.sources.find((s) => s.id === "strava-activities");
if (!realActivitiesSource?.analyticsSchemas) {
  throw new Error("synth strava: real provider's strava-activities source has no analyticsSchemas");
}
function requireSchema(tableName: string): AnalyticsTableSchema {
  const s = realActivitiesSource!.analyticsSchemas!.find((x) => x.tableName === tableName);
  if (!s) throw new Error(`synth strava: real provider missing analytics schema '${tableName}'`);
  return s;
}
const STRAVA_ACTIVITIES_SCHEMA = requireSchema("strava_activities");
const STRAVA_ZONES_SCHEMA = requireSchema("strava_activity_zones");

/**
 * Hybrid sync cursor. One page writes both tables, so the only states are
 * "not yet synced" and "done"; `zones` remains spellable so a cursor persisted
 * by an install that paged through it lands on the terminal branch instead of
 * failing to parse.
 */
interface StravaSynthCursor extends SynthCursor {
  phase?: "activities" | "zones" | "done";
}

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "oauth",
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("strava", [accountId]),
  authFlow: async (_p, cb) => fakeOAuthFlow("strava", "Strava", accountId, cb),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares has to be overridden here or a demo run reaches
  // the real service.
  authenticate: undefined,
  // A double drives its own cursor, which the real source's decoder does not
  // know. Inheriting the declaration would refuse that cursor on the tick
  // after the first one and park the source.
  contract: undefined,
  cleanupCredentials: undefined,
  createContext: async () => ({}),
  // A synthetic double has no credential to be in a state about, and says so
  // outright: the real provider's declaration would otherwise leak through
  // the spread above with a context type this double does not have.
  credentialState: () => Promise.resolve({ status: "connected" as const }),
  disposeContext: async () => {},
  sources: rest.sources.map((s) => ({
    ...s,
    // The double drives its own cursor; the real source's decoder does not
    // know it. Inheriting the declaration refuses that cursor on the next tick.
    contract: undefined,
    analyticsSchemas: [STRAVA_ACTIVITIES_SCHEMA, STRAVA_ZONES_SCHEMA],
    async create({ sourceId, providerId, accountId }) {
      const athleteId = Number(accountId);
      if (!/^[1-9]\d*$/.test(accountId) || !Number.isSafeInteger(athleteId)) {
        throw new Error("Synthetic Strava requires a numeric athlete account");
      }
      const allActivities = loadActivities();
      const zones = loadZones();
      return {
        analyticsSchemas: [STRAVA_ACTIVITIES_SCHEMA, STRAVA_ZONES_SCHEMA],
        async sync() {
          // Structured sources route through syncStructured below; this
          // never gets called by the engine, but the source SDK requires
          // the method to exist.
          return syncPage([], { phase: "done" } as StravaSynthCursor, { hasMore: false });
        },
        async syncStructured(cursor): Promise<StructuredSyncResult<StravaSynthCursor>> {
          // Resolved per sync, never at create() time — see granola for why.
          const { visible: activities, presentExternalIds } = impairedSnapshot(
            allActivities,
            sourceId,
            (e) => e.externalId,
          );
          const cur = (cursor as StravaSynthCursor | null) ?? {};
          if ((cur.phase ?? "activities") !== "activities") {
            return { cursor: { ...cur, phase: "done" }, hasMore: false };
          }
          // Activities and their zone buckets are one upstream read and two
          // tables, so they are one page. Splitting them across pages would
          // make the zone rows arrive under a cursor that already claimed the
          // activities were finished.
          return {
            analytics: [
              {
                tableName: STRAVA_ACTIVITIES_SCHEMA.tableName,
                records: activities.map((activity) => mapActivityRecord(activity, athleteId)),
                schema: STRAVA_ACTIVITIES_SCHEMA,
              },
              {
                tableName: STRAVA_ZONES_SCHEMA.tableName,
                records: zones.map((zone) => mapZoneRecord(zone, athleteId)),
                schema: STRAVA_ZONES_SCHEMA,
              },
            ],
            documents: activities.map((e) => mapActivity(e, { sourceId, providerId })),
            cursor: { ...cur, phase: "done" },
            hasMore: false,
            presentExternalIds,
          };
        },
      };
    },
  })),
});
