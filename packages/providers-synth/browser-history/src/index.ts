// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realBrowserHistory from "@omnesis/provider-browser-history";
import { defineStructuredSource, syncPage } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  sha256Hex,
  type SynthCursor,
  impairedSnapshot,
} from "@omnesis/providers-synth-common";
import {
  allVisits,
  allDaily,
  allSearches,
  browserSlug,
  profileName,
  fixtureDays,
  type VisitRow,
} from "./fixtures.js";
import type { AnalyticsTableSchema, StructuredSyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

const {
  type: _t,
  analyticsSchemas,
  // Dropped at the destructure so it cannot reach the spread below: the double
  // drives its own cursor, and the real source's decoder would refuse it on the
  // tick after the first one and park the source.
  contract: _contract,
  ...rest
} = realBrowserHistory as unknown as Record<string, unknown> & {
  analyticsSchemas?: AnalyticsTableSchema[];
};

if (!analyticsSchemas || analyticsSchemas.length !== 3) {
  throw new Error(
    "synth browser-history: real provider's analyticsSchemas changed shape — expected [visits, daily, search_terms]",
  );
}
const [VISITS_SCHEMA, DAILY_SCHEMA, SEARCHES_SCHEMA] = analyticsSchemas;

interface Cursor extends SynthCursor {
  /**
   * One page writes every table, then a second emits the daily-summary
   * documents. The per-table names stay spellable so a cursor persisted by an
   * install that paged through them lands on the rows page rather than failing
   * to parse.
   */
  phase?: "rows" | "visits" | "daily" | "search_terms" | "documents" | "done";
}

function dailyDocument(
  date: string,
  visits: VisitRow[],
  sourceId: SourceId,
  providerId: ProviderId,
): DocumentInput {
  const byHour = new Map<string, VisitRow[]>();
  for (const v of visits) {
    const hourKey = v.timestamp.slice(11, 16);
    const arr = byHour.get(hourKey) ?? [];
    arr.push(v);
    byHour.set(hourKey, arr);
  }
  const sections: string[] = [];
  for (const hour of [...byHour.keys()].sort()) {
    sections.push(`## ${hour}`);
    for (const v of byHour.get(hour)!) {
      const duration = v.visit_duration_seconds
        ? `${Math.round(v.visit_duration_seconds / 60)}m`
        : "—";
      sections.push(`- [${v.title}](${v.url}) — ${duration}`);
    }
    sections.push("");
  }
  const content = `# ${browserSlug()} browsing — ${date}\n\n${sections.join("\n")}`;
  return {
    sourceId,
    providerId,
    externalId: `${browserSlug()}:${date}`,
    title: `${browserSlug()} browsing — ${date}`,
    content,
    contentHash: sha256Hex(`${browserSlug()}:${date}:${visits.length}`),
    metadata: {
      documentType: "browsing-history",
      extra: {
        date,
        browser: browserSlug(),
        profile: profileName(),
        visitCount: visits.length,
      },
    },
    sourceCreatedAt: `${date}T00:00:00.000Z`,
    sourceUpdatedAt: `${date}T23:59:59.000Z`,
  };
}

export default defineStructuredSource<Cursor>({
  ...(rest as { id: string; name: string; description: string; authType: "local" }),
  analyticsSchemas: [VISITS_SCHEMA, DAILY_SCHEMA, SEARCHES_SCHEMA],
  credentials: undefined,
  discover: async () => preDiscoveredAccounts("browser-history", [browserSlug()]),
  authFlow: async () => fakeLocalFlow("browser-history", browserSlug()),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares has to be overridden here or a demo run reaches
  // the real service.
  authenticate: undefined,
  cleanupCredentials: undefined,
  async create({ sourceId, providerId }) {
    return {
      analyticsSchemas: [VISITS_SCHEMA, DAILY_SCHEMA, SEARCHES_SCHEMA],
      async sync() {
        // Daily-summary docs flow through `syncStructured.documents`, not the
        // unstructured `sync()` channel. Returning empty here keeps the
        // engine's unstructured branch a no-op.
        return syncPage([], { phase: "done" } as Cursor, { hasMore: false });
      },
      async syncStructured(cursor): Promise<StructuredSyncResult<Cursor>> {
        const phase = (cursor?.phase as Cursor["phase"]) ?? "rows";
        if (phase === "done") {
          return { cursor: { phase: "done" }, hasMore: false };
        }
        if (phase !== "documents") {
          // Visits, their daily rollups and the searches that led to them are
          // one read of the corpus and three tables, so they are one page.
          return {
            analytics: [
              {
                tableName: VISITS_SCHEMA.tableName,
                records: allVisits() as unknown as Record<string, unknown>[],
                schema: VISITS_SCHEMA,
              },
              {
                tableName: DAILY_SCHEMA.tableName,
                records: allDaily() as unknown as Record<string, unknown>[],
                schema: DAILY_SCHEMA,
              },
              {
                tableName: SEARCHES_SCHEMA.tableName,
                records: allSearches() as unknown as Record<string, unknown>[],
                schema: SEARCHES_SCHEMA,
              },
            ],
            cursor: { phase: "documents" },
            hasMore: true,
          };
        }
        // documents phase: emit one daily-summary Document per fixture day.
        const visits = allVisits();
        const byDay = new Map<string, VisitRow[]>();
        for (const v of visits) {
          const date = v.timestamp.slice(0, 10);
          const arr = byDay.get(date) ?? [];
          arr.push(v);
          byDay.set(date, arr);
        }
        const allDocs = fixtureDays()
          .filter((d) => byDay.has(d))
          .map((d) => dailyDocument(d, byDay.get(d)!, sourceId, providerId));
        const { visible: docs, presentExternalIds } = impairedSnapshot(
          allDocs,
          sourceId,
          (d) => d.externalId,
        );
        return {
          documents: docs,
          presentExternalIds,
          cursor: { phase: "done" },
          hasMore: false,
        };
      },
    };
  },
});
