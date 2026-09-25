// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realGoogle, { GoogleCalendarSource } from "@omnesis/provider-google";
import { defineProvider } from "@omnesis/source-sdk";
import {
  fakeOAuthFlow,
  pageFromFixture,
  preDiscoveredAccounts,
  syncFromFixture,
  selfAccountId,
  type SynthCursor,
  impairEntries,
} from "@omnesis/providers-synth-common";
import {
  loadEmails,
  loadEvents,
  loadFiles,
  loadContacts,
  mapEmail,
  mapEvent,
  mapEventRecord,
  mapDriveFile,
  mapContact,
} from "./fixtures.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";

const { type: _type, ...rest } = realGoogle;
const accountId = selfAccountId("email");
const GOOGLE_CALENDAR_SCHEMA = new GoogleCalendarSource(
  {} as ConstructorParameters<typeof GoogleCalendarSource>[0],
).analyticsSchemas[0];

interface SourceWiring {
  load: () => unknown[];
  map: (e: any, ctx: any) => any;
}

const wiring: Record<string, SourceWiring> = {
  gmail: { load: loadEmails, map: mapEmail },
  "google-calendar": { load: loadEvents, map: mapEvent },
  "google-drive": { load: loadFiles, map: mapDriveFile },
  "google-contacts": { load: loadContacts, map: mapContact },
};

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "oauth",
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("google", [accountId]),
  authFlow: async (_p, cb) => fakeOAuthFlow("google", "Google", accountId, cb),
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
    if (s.id === "google-calendar") {
      return {
        ...s,
        // The double drives its own cursor; the real source's decoder does not
        // know it. Inheriting the declaration refuses that cursor on the next tick.
        contract: undefined,
        analyticsSchemas: [GOOGLE_CALENDAR_SCHEMA],
        async create({ accountId: sourceAccount, sourceId, providerId }) {
          const entries = loadEvents();
          const context = { sourceId, providerId };
          return {
            analyticsSchemas: [GOOGLE_CALENDAR_SCHEMA],
            async sync(cursor: SynthCursor | null) {
              return syncFromFixture(entries, cursor, (entry) => mapEvent(entry, context), {
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
                  tableName: GOOGLE_CALENDAR_SCHEMA.tableName,
                  records: batch.map((entry) => mapEventRecord(entry, String(sourceAccount))),
                  schema: GOOGLE_CALENDAR_SCHEMA,
                  presentIds: isFinalPage ? snapshotIds : undefined,
                },
                documents: batch.map((entry) => mapEvent(entry, context)),
                cursor: newCursor,
                hasMore,
                presentExternalIds: isFinalPage ? snapshotIds : undefined,
              };
            },
          };
        },
      };
    }
    return {
      ...s,
      // The double drives its own cursor; the real source's decoder does not
      // know it. Inheriting the declaration refuses that cursor on the next tick.
      contract: undefined,
      async create({ sourceId, providerId }) {
        const w = wiring[s.id];
        if (!w) throw new Error(`No synth wiring for google source: ${s.id}`);
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
