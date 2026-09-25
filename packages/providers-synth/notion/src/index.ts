// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realNotion from "@omnesis/provider-notion";
import { defineProvider, syncPage } from "@omnesis/source-sdk";
import {
  fakeOAuthFlow,
  preDiscoveredAccounts,
  syncFromFixture,
  selfAccountId,
  type SynthCursor,
  impairedSnapshot,
  impairEntries,
  readImpairment,
  synthPartitionOf,
  SYNTH_UNREADABLE_PARTITION,
} from "@omnesis/providers-synth-common";
import {
  loadPages,
  loadDatabases,
  mapPage,
  schemaForDatabase,
  rowsAsRecords,
  databaseSummaryDocument,
  databaseRowDocument,
  tableNameFor,
} from "./fixtures.js";
import type { ProviderSourceEntry, StructuredSyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

const { type: _type, ...rest } = realNotion;
const accountId = selfAccountId("extra", "notionUserId");

interface DatabasesCursor extends SynthCursor {
  /** Index into the databases fixture. -1 = not started, length = done. */
  dbIndex?: number;
}

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "oauth",
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("notion", [accountId]),
  authFlow: async (_p, cb) => fakeOAuthFlow("notion", "Notion", accountId, cb),
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
  // The real notion provider parametrises on NotionContext for its OAuth client.
  // The synth replaces createContext with a no-op so the typed context is gone —
  // cast through `unknown` rather than try to round-trip the parametric type.
  sources: rest.sources.map((s): ProviderSourceEntry<Record<string, never>> => {
    const generic = s as unknown as ProviderSourceEntry<Record<string, never>>;
    if (s.id === "notion-pages") {
      return {
        ...generic,
        // The double drives its own cursor; the real source's decoder does not
        // know it. Inheriting the declaration refuses that cursor on the next tick.
        contract: undefined,
        async create({ sourceId, providerId }) {
          const entries = loadPages();
          return {
            async sync(cursor) {
              return syncFromFixture(
                entries,
                cursor as SynthCursor | null,
                (e) => mapPage(e, { sourceId, providerId }),
                { sourceId },
              );
            },
          };
        },
      };
    }
    if (s.id === "notion-databases") {
      return {
        ...generic,
        // The double drives its own cursor; the real source's decoder does not
        // know it. Inheriting the declaration refuses that cursor on the next tick.
        contract: undefined,
        // Dynamic schemas — one per database — flow through the analytics
        // table write's `schema` field. The static field stays empty to
        // match the real Notion source.
        analyticsSchemas: [],
        async create({ sourceId, providerId }) {
          const databases = loadDatabases();
          return {
            // Hybrid source: declare emptyish static schemas (the gateway
            // accepts dynamic schemas via the table write's `schema`), implement
            // both `sync` (no-op) and `syncStructured` (the real work).
            analyticsSchemas: [],
            async sync(): Promise<ReturnType<typeof syncPage>> {
              return syncPage([], { dbIndex: databases.length } as DatabasesCursor, {
                hasMore: false,
              });
            },
            async syncStructured(cursor): Promise<StructuredSyncResult<DatabasesCursor>> {
              const c = (cursor as DatabasesCursor) ?? {};
              // The databases ARE this source's partitions, so the partitioned
              // mode is decided over them rather than over rows: one database
              // cannot be opened, and the rest are read in full. Every other
              // mode keeps its row-level meaning below.
              const partitioned = readImpairment(sourceId)?.mode === "partitioned";
              const readable = partitioned
                ? databases.filter((_, i) => synthPartitionOf(i) !== SYNTH_UNREADABLE_PARTITION)
                : databases;
              // Within the readable half, the last `hide` databases are
              // genuinely gone upstream — the deletion the claims below are
              // supposed to let the gateway find.
              const walked = partitioned
                ? impairEntries(databases, sourceId, (d) => `db-${d.dbId}`).visible
                : databases;
              const idsOf = (d: (typeof databases)[number]): string[] => [
                `db-${d.dbId}`,
                ...d.rows.map((r) => `row-${r.id}`),
              ];
              // Every database this cycle could open is claimed by name. One it
              // could open and found empty — a database deleted upstream — is
              // claimed with no ids, which is how a partition says everything
              // in it is gone. The unreadable half is claimed by nothing, so
              // the gateway leaves it alone.
              const stillThere = new Set(walked.map((d) => d.dbId));
              const claims = readable.map((d) => ({
                partition: d.dbId,
                ids: stillThere.has(d.dbId) ? idsOf(d) : [],
              }));
              const allIds = databases.flatMap((d) => idsOf(d));
              const { presentExternalIds } = impairedSnapshot(allIds, sourceId, (id) => id);

              // A finished walk starts again rather than falling silent. The
              // real source re-walks on a cadence and publishes a fresh
              // enumeration each time; a double that walked its fixture once
              // and then returned nothing would let a corpus drift with no
              // later cycle to correct it.
              const previous = c.dbIndex ?? 0;
              const idx = previous >= walked.length ? 0 : previous;

              if (walked.length === 0) {
                // Nothing readable at all. The cycle enumerated no partition,
                // so it vouches for nothing.
                return { documents: [], cursor: { dbIndex: 0 }, hasMore: false };
              }
              const db = walked[idx];
              const schema = schemaForDatabase(db);
              const records = rowsAsRecords(db);
              const ctx = { sourceId: sourceId as SourceId, providerId: providerId as ProviderId };
              // Stamped on every cycle, healthy ones included: a claim only
              // reaches documents whose stored partition it names, so a key
              // that appeared the moment a cycle went partitioned would leave
              // every earlier document unreachable and the sweep would pass by
              // touching nothing.
              const documents: DocumentInput[] = [
                databaseSummaryDocument(db, ctx),
                ...db.rows.map((r) => databaseRowDocument(db, r, ctx)),
              ].map((doc) => ({ ...doc, partitionKey: db.dbId }));
              const isFinalPage = idx === walked.length - 1;
              // `presentExternalIds` enumerates EVERY external id this source
              // owns when we're emitting the final page. The gateway then
              // prunes any prior doc whose id isn't in the snapshot, just
              // like the real Notion snapshot-rewalk does — and, like the real
              // one, it is withheld when the read could not see everything.
              const { visible: visibleDocuments } = partitioned
                ? { visible: documents }
                : impairEntries(documents, sourceId);
              return {
                analytics: { tableName: tableNameFor(db.dbId), records, schema },
                documents: visibleDocuments,
                cursor: { dbIndex: idx + 1 },
                hasMore: !isFinalPage,
                ...(isFinalPage && partitioned ? { presentClaims: claims } : {}),
                presentExternalIds: isFinalPage && !partitioned ? presentExternalIds : undefined,
              };
            },
          };
        },
      };
    }
    return generic;
  }),
});
