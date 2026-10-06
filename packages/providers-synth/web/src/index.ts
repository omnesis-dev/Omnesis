// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import realSource from "@omnesis/provider-web";
import { defineStructuredSource, syncPage } from "@omnesis/source-sdk";
import { computeContentHash } from "@omnesis/core";
import { normalizeUrl } from "@omnesis/core/url-normalize";
import { buildWebPageDocument, buildPageVisit } from "@omnesis/extension";
import {
  fakeLocalFlow,
  loadActiveUniverse,
  loadSourceFixtureJson,
  pageFromFixture,
  preDiscoveredAccounts,
  universeAccounts,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
const pageSchema = z
  .object({
    url: z.url(),
    title: z.string(),
    content: z.string(),
    visitedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    dwellMs: z.number().int().min(5000),
    profile: z.string().optional(),
  })
  .strict();
export type WebFixturePage = z.infer<typeof pageSchema>;
export function loadPages(): WebFixturePage[] {
  return z
    .array(pageSchema)
    .parse(loadSourceFixtureJson<unknown>(loadActiveUniverse(), "web", "pages.json"));
}
export async function mapPage(
  entry: WebFixturePage,
  sourceId: SourceId,
  providerId: ProviderId,
): Promise<DocumentInput> {
  const normalizedUrl = normalizeUrl(entry.url);
  if (!normalizedUrl) throw new Error("Synthetic web page URL is not supported");
  const document = await buildWebPageDocument({
    normalizedUrl,
    title: entry.title,
    text: entry.content,
    contentHash: computeContentHash(entry.content),
    visitedAt: entry.visitedAt,
  });
  return { ...document, sourceId, providerId };
}
const { type: _type, ...rest } = realSource;
const schemas = rest.analyticsSchemas ?? [];
const schema = schemas[0];
if (!schema) throw new Error("Web source must declare its page visit schema");
/** Synthetic pull bridge for a source normally populated by the browser push API. */
export default defineStructuredSource<SynthCursor>({
  ...rest,
  analyticsSchemas: schemas,
  gatewayHosted: false,
  execution: "pull",
  pushBased: false,
  discover: async () => preDiscoveredAccounts("web", universeAccounts("web")),
  authFlow: async () => fakeLocalFlow("web", universeAccounts("web")[0] ?? "synthetic"),
  async create({ sourceId, providerId }) {
    const entries = loadPages();
    return {
      analyticsSchemas: schemas,
      sync: async () => syncPage([], { offset: entries.length }),
      async syncStructured(cursor) {
        const { batch, newCursor, hasMore, isFinalPage } = pageFromFixture(entries, cursor);
        const documents = await Promise.all(
          batch.map((entry) => mapPage(entry, sourceId, providerId)),
        );
        return {
          analytics: {
            tableName: schema.tableName,
            schema,
            records: batch.map((entry) => {
              const normalizedUrl = normalizeUrl(entry.url);
              if (!normalizedUrl) throw new Error("Synthetic web page URL is not supported");
              return {
                ...buildPageVisit({
                  normalizedUrl,
                  title: entry.title,
                  visitedAt: entry.visitedAt,
                  dwellMs: entry.dwellMs,
                }),
                browser_device_id: null,
                browser_profile_label: entry.profile ?? null,
              };
            }),
          },
          documents,
          cursor: newCursor,
          hasMore,
          presentExternalIds: isFinalPage
            ? [
                ...new Set(
                  (
                    await Promise.all(entries.map((entry) => mapPage(entry, sourceId, providerId)))
                  ).map((document) => document.externalId),
                ),
              ]
            : undefined,
        };
      },
    };
  },
});
