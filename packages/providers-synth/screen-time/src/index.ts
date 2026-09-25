// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realScreenTime, { buildDailyDigests } from "@omnesis/provider-screen-time";
import { defineStructuredSource, syncPage } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  getPerson,
  loadCast,
  preDiscoveredAccounts,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import { allSessions, allDaily } from "./fixtures.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";

const {
  type: _t,
  analyticsSchemas,
  create: _realCreate,
  discover: _realDisc,
  authFlow: _realAuth,
  // Dropped at the destructure so it cannot reach the spread below: the double
  // drives its own cursor, and the real source's decoder would refuse it on the
  // tick after the first one and park the source.
  contract: _contract,
  ...rest
} = realScreenTime as unknown as Record<string, unknown> & {
  analyticsSchemas?: import("@omnesis/core").AnalyticsTableSchema[];
};

if (!analyticsSchemas || analyticsSchemas.length !== 2) {
  throw new Error(
    "synth screen-time: real provider's analyticsSchemas changed shape — expected [sessions, daily]",
  );
}
const [SESSIONS_SCHEMA, DAILY_SCHEMA] = analyticsSchemas;

interface Cursor extends SynthCursor {
  phase?: "sessions" | "daily" | "done";
}

// Derive the iCloud account from the cast so it matches whatever the active
// universe configures for Screen Time (same rule as the apple synth provider:
// a stale hardcoded value silently desyncs from the universe manifest).
const self = getPerson("self", loadCast());
const accountId =
  self.emails?.find((e) => e.includes("@icloud")) ?? self.emails?.[0] ?? "john@icloud.com";

export default defineStructuredSource<Cursor>({
  ...(rest as { id: string; name: string; description: string; authType: "local" }),
  // Spread carries id, name, description, icon, etc. from the real provider.
  // Override the bits we own.
  analyticsSchemas: [SESSIONS_SCHEMA, DAILY_SCHEMA],
  // The real source declares a path that has to exist on this machine. A
  // double that inherited the check would refuse to instantiate on a host that
  // has never run the real app.
  config: undefined,
  singleInstance: true,
  supportedPlatforms: undefined,
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("screen-time", [accountId]),
  authFlow: async () => fakeLocalFlow("screen-time", accountId),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares has to be overridden here or a demo run reaches
  // the real service.
  authenticate: undefined,
  cleanupCredentials: undefined,
  async create({ sourceId, providerId, sourceConfig }) {
    const deviceVariant = sourceConfig?.params?.__syntheticDeviceId ?? "";
    return {
      analyticsSchemas: [SESSIONS_SCHEMA, DAILY_SCHEMA],
      async sync() {
        // The standalone unstructured lane is empty; syncStructured co-emits
        // the searchable daily digest documents with the daily rows.
        return syncPage([], { phase: "done" } as Cursor, { hasMore: false });
      },
      async syncStructured(cursor): Promise<StructuredSyncResult<Cursor>> {
        const phase = (cursor?.phase as Cursor["phase"]) ?? "sessions";
        if (phase === "done") {
          return { cursor: { phase: "done" }, hasMore: false };
        }
        if (phase === "sessions") {
          return {
            analytics: {
              tableName: SESSIONS_SCHEMA.tableName,
              records: allSessions(deviceVariant) as unknown as Record<string, unknown>[],
              schema: SESSIONS_SCHEMA,
            },
            cursor: { phase: "daily" },
            hasMore: true,
          };
        }
        return {
          analytics: {
            tableName: DAILY_SCHEMA.tableName,
            records: allDaily(deviceVariant) as unknown as Record<string, unknown>[],
            schema: DAILY_SCHEMA,
          },
          documents: buildDailyDigests(
            allDaily(deviceVariant) as unknown as Record<string, unknown>[],
            providerId,
            sourceId,
          ),
          cursor: { phase: "done" },
          hasMore: false,
        };
      },
    };
  },
});
