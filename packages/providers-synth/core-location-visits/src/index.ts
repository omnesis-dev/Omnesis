// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineStructuredSource, syncPage } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  pageFromFixture,
  preDiscoveredAccounts,
  type SynthCursor,
  impairEntries,
} from "@omnesis/providers-synth-common";
import {
  loadLocationVisits,
  mapLocationVisitDocument,
  mapLocationVisitRecord,
} from "./fixtures.js";
import { LOCATION_VISITS_SCHEMA } from "./schema.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";

// Synthetic mobile fixtures must not claim the fixed `:local` account used by
// a real phone when both contribute to the same gateway.
const accountId = "ios-synth-johnsmith";

export default defineStructuredSource<SynthCursor>({
  id: "core-location-visits",
  name: "Location Visits",
  description: "Completed, on-device named location visits",
  authType: "local",
  unitName: "visits",
  singleInstance: true,
  primaryCount: "analytics",
  icon: {
    sfSymbol: "location.fill",
    color: "#5E5CE6",
  },
  analyticsSchemas: [LOCATION_VISITS_SCHEMA],
  discover: async () => preDiscoveredAccounts("core-location-visits", [accountId]),
  authFlow: async () => fakeLocalFlow("core-location-visits", accountId),
  async create({ sourceId, providerId }) {
    const entries = loadLocationVisits();
    const context = { sourceId, providerId };
    return {
      analyticsSchemas: [LOCATION_VISITS_SCHEMA],
      async sync() {
        // The collector chooses `syncStructured` for this hybrid source. Keep
        // the unstructured side empty so an accidental direct call cannot
        // duplicate its co-emitted documents.
        return syncPage([], { offset: entries.length }, { hasMore: false });
      },
      async syncStructured(cursor: SynthCursor | null): Promise<StructuredSyncResult<SynthCursor>> {
        // Resolved per sync: `create` runs once at collector boot, so an
        // impairment read there would be frozen before any test could set one.
        const { visible, snapshotAllowed } = impairEntries(entries, sourceId, (entry) => entry.id);
        const snapshotIds = snapshotAllowed ? visible.map((entry) => entry.id) : undefined;
        const { batch, newCursor, hasMore, isFinalPage } = pageFromFixture(visible, cursor);
        return {
          analytics: {
            tableName: LOCATION_VISITS_SCHEMA.tableName,
            records: batch.map((entry) => mapLocationVisitRecord(entry, accountId)),
            schema: LOCATION_VISITS_SCHEMA,
            presentIds: isFinalPage ? snapshotIds : undefined,
          },
          documents: batch.map((entry) => mapLocationVisitDocument(entry, context)),
          cursor: newCursor,
          hasMore,
          presentExternalIds: isFinalPage ? snapshotIds : undefined,
        };
      },
    };
  },
});
