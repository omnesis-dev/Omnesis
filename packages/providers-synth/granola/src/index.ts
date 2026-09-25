// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realGranola, { granolaMeetingsSchema } from "@omnesis/provider-granola";
import { defineProvider, syncPage } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  selfAccountId,
  type SynthCursor,
  impairedSnapshot,
} from "@omnesis/providers-synth-common";
import { loadMeetings, mapMeetingDocument, mapMeetingRecord } from "./fixtures.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";

const { type: _type, ...rest } = realGranola;

// Granola keys an account by the owner's email — the real provider derives the
// account id from the note owner. Use the cast's "self" email so the synthetic
// notes resolve onto John in the people graph.
const accountId = selfAccountId("email");

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "api-key",
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("granola", [accountId]),
  // api-key sources have no browser leg — the local flow just marks the pair
  // and returns the resolved account id.
  authFlow: async () => fakeLocalFlow("granola", accountId),
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
  sources: rest.sources.map((s) => ({
    ...s,
    // The double drives its own cursor; the real source's decoder does not
    // know it. Inheriting the declaration refuses that cursor on the next tick.
    contract: undefined,
    analyticsSchemas: [granolaMeetingsSchema],
    async create({ sourceId, providerId, accountId }) {
      const allMeetings = loadMeetings();
      return {
        analyticsSchemas: [granolaMeetingsSchema],
        async sync() {
          // Structured sources route through syncStructured; the SDK still
          // requires a sync() to exist.
          return syncPage([], { offset: 0 } as SynthCursor, { hasMore: false });
        },
        async syncStructured(): Promise<StructuredSyncResult<SynthCursor>> {
          // Resolved per sync, never at create() time: `create` runs once when
          // the collector boots, so an impairment read there is frozen at
          // whatever the environment held before any test could set it.
          const { visible: meetings, presentExternalIds } = impairedSnapshot(
            allMeetings,
            sourceId,
            (e) => e.id,
          );
          // One page: emit every meeting as both a `granola_meetings` row and a
          // searchable document (summary + transcript), reusing the real
          // normalizer so the synth stays in lockstep with production output.
          return {
            analytics: {
              tableName: granolaMeetingsSchema.tableName,
              records: meetings.map((note) => mapMeetingRecord(note, accountId)),
              schema: granolaMeetingsSchema,
            },
            documents: meetings.map((e) => mapMeetingDocument(e, { sourceId, providerId })),
            cursor: { offset: meetings.length } as SynthCursor,
            hasMore: false,
            presentExternalIds,
          };
        },
      };
    },
  })),
});
