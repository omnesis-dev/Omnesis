// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realApple, { AppleCalendarSource, AppleCallLogSource } from "@omnesis/provider-apple";
import { defineProvider } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  getPerson,
  loadCast,
  pageFromFixture,
  preDiscoveredAccounts,
  syncFromFixture,
  type SynthCursor,
  impairEntries,
} from "@omnesis/providers-synth-common";
import {
  loadNotes,
  loadReminders,
  loadChats,
  loadContacts,
  loadCalendarEvents,
  loadCallLog,
  loadVoicemails,
  mapNote,
  mapReminder,
  mapChat,
  mapContact,
  mapCalendarEvent,
  mapCalendarEventRecord,
  mapCallLog,
  mapCallLogRecords,
  mapVoicemail,
} from "./fixtures.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";

const { type: _type, ...rest } = realApple;
// Derive the iCloud account from the cast so it matches whatever the active
// universe configures for the Apple sources (every other synth provider keys
// its account off the cast too). A stale hardcoded value silently desyncs:
// if it doesn't match the universe's configured account, the Apple sources
// never sync, so the gateway has no source-meta for them and clients fall
// back to a placeholder icon + the raw source type.
const self = getPerson("self", loadCast());
const accountId =
  self.emails?.find((e) => e.includes("@icloud")) ?? self.emails?.[0] ?? "john@icloud.com";
const APPLE_CALENDAR_SCHEMA = new AppleCalendarSource(
  { calendarDbFilePath: "/dev/null" } as ConstructorParameters<typeof AppleCalendarSource>[0],
  {
    sourceId: "apple-calendar:synth",
    providerId: "apple:synth",
  },
).analyticsSchemas[0];
const APPLE_CALL_LOG_SCHEMA = new AppleCallLogSource(
  { callLogDbFilePath: "/dev/null" } as ConstructorParameters<typeof AppleCallLogSource>[0],
  {
    sourceId: "apple-call-log:synth",
    providerId: "apple:synth",
  },
).analyticsSchemas[0];

interface SourceWiring {
  load: () => unknown[];
  map: (e: any, ctx: any) => any;
}

const wiring: Record<string, SourceWiring> = {
  "apple-notes": { load: loadNotes, map: mapNote },
  "apple-reminders": { load: loadReminders, map: mapReminder },
  "apple-imessage": { load: loadChats, map: mapChat },
  "apple-contacts": { load: loadContacts, map: mapContact },
  "apple-calendar": { load: loadCalendarEvents, map: mapCalendarEvent },
  "apple-call-log": { load: loadCallLog, map: mapCallLog },
  "apple-voicemail": { load: loadVoicemails, map: mapVoicemail },
};

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "local",
  supportedPlatforms: undefined,
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("apple", [accountId]),
  authFlow: async () => fakeLocalFlow("apple", accountId),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares has to be overridden here or a demo run reaches
  // the real service.
  authenticate: undefined,
  cleanupCredentials: undefined,
  createContext: async () => ({}),
  // A synthetic double has no credential to be in a state about, and says so
  // outright: the real provider's declaration would otherwise leak through
  // the spread above with a context type this double does not have.
  credentialState: () => Promise.resolve({ status: "connected" as const }),
  disposeContext: async () => {},
  sources: rest.sources.map((s) => {
    if (s.id === "apple-calendar") {
      return {
        ...s,
        discover: undefined,
        // The double drives its own cursor; the real source's decoder does not
        // know it. Inheriting the declaration refuses that cursor on the next tick.
        contract: undefined,
        supportedPlatforms: undefined,
        analyticsSchemas: [APPLE_CALENDAR_SCHEMA],
        async create({ sourceId, providerId }) {
          const entries = loadCalendarEvents();
          const context = { sourceId, providerId };
          return {
            analyticsSchemas: [APPLE_CALENDAR_SCHEMA],
            async sync(cursor: SynthCursor | null) {
              return syncFromFixture(entries, cursor, (entry) => mapCalendarEvent(entry, context), {
                sourceId,
              });
            },
            async syncStructured(
              cursor: SynthCursor | null,
            ): Promise<StructuredSyncResult<SynthCursor>> {
              // Resolved per sync, never at create() time.
              const { visible, snapshotAllowed } = impairEntries(
                entries,
                sourceId,
                (entry) => entry.externalId,
              );
              const snapshotIds = snapshotAllowed
                ? visible.map((entry) => entry.externalId)
                : undefined;
              const { batch, newCursor, hasMore, isFinalPage } = pageFromFixture(visible, cursor);
              return {
                analytics: {
                  tableName: APPLE_CALENDAR_SCHEMA.tableName,
                  records: batch.map(mapCalendarEventRecord),
                  schema: APPLE_CALENDAR_SCHEMA,
                  presentIds: isFinalPage ? snapshotIds : undefined,
                },
                documents: batch.map((entry) => mapCalendarEvent(entry, context)),
                cursor: newCursor,
                hasMore,
                presentExternalIds: isFinalPage ? snapshotIds : undefined,
              };
            },
          };
        },
      };
    }
    if (s.id === "apple-call-log") {
      return {
        ...s,
        discover: undefined,
        // The double drives its own cursor; the real source's decoder does not
        // know it. Inheriting the declaration refuses that cursor on the next tick.
        contract: undefined,
        supportedPlatforms: undefined,
        analyticsSchemas: [APPLE_CALL_LOG_SCHEMA],
        async create({ sourceId, providerId }) {
          const entries = loadCallLog();
          const context = { sourceId, providerId };
          return {
            analyticsSchemas: [APPLE_CALL_LOG_SCHEMA],
            async sync(cursor: SynthCursor | null) {
              return syncFromFixture(entries, cursor, (entry) => mapCallLog(entry, context), {
                sourceId,
              });
            },
            async syncStructured(
              cursor: SynthCursor | null,
            ): Promise<StructuredSyncResult<SynthCursor>> {
              const { visible, snapshotAllowed } = impairEntries(
                entries,
                sourceId,
                (entry) => entry.externalId,
              );
              const snapshotExternalIds = snapshotAllowed
                ? visible.map((entry) => entry.externalId)
                : undefined;
              const { batch, newCursor, hasMore, isFinalPage } = pageFromFixture(visible, cursor);
              return {
                analytics: {
                  tableName: APPLE_CALL_LOG_SCHEMA.tableName,
                  records: mapCallLogRecords(batch),
                  schema: APPLE_CALL_LOG_SCHEMA,
                },
                documents: batch.map((entry) => mapCallLog(entry, context)),
                cursor: newCursor,
                hasMore,
                presentExternalIds: isFinalPage ? snapshotExternalIds : undefined,
              };
            },
          };
        },
      };
    }
    return {
      ...s,
      discover: undefined,
      // The double drives its own cursor; the real source's decoder does not
      // know it. Inheriting the declaration refuses that cursor on the next tick.
      contract: undefined,
      async create({ sourceId, providerId }) {
        const w = wiring[s.id];
        if (!w) throw new Error(`No synth wiring for apple source: ${s.id}`);
        const entries = w.load();
        return {
          async sync(cursor) {
            return syncFromFixture(entries, cursor, (e) => w.map(e, { sourceId, providerId }), {
              sourceId,
            });
          },
        };
      },
    };
  }),
});
