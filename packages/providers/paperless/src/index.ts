// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readProviderAccountCredentials } from "@omnesis/core";
import { defineProvider, emptySync, readConnectionState } from "@omnesis/source-sdk";
import { PaperlessClient } from "./client.js";
import {
  authenticate as paperlessAuthenticate,
  cleanupCredentials,
  discoverAccounts,
  hasCredentials,
  loadConnection,
  PAPERLESS_FILE_KEY,
} from "./provider.js";
import { paperlessCredentialsSpec } from "./credentials-spec.js";
import { paperlessDocumentEventProfile } from "./document-event-profile.js";
import { PaperlessDocumentsSource } from "./documents.js";
import { paperlessIcon } from "./icons.js";
import { allSchemas } from "./schemas.js";
import { paperlessDocumentsStateSpec } from "./state.js";
import { validatePaperlessDocumentsCursor } from "./types.js";
import type { PaperlessContext } from "./types.js";

export { PaperlessClient, normalizeBaseUrl } from "./client.js";
export { paperlessCredentialsSpec } from "./credentials-spec.js";
export { PaperlessDocumentsSource } from "./documents.js";
export { normalizeDocument } from "./normalizer.js";
export {
  allSchemas,
  paperlessCustomFieldValuesSchema,
  paperlessDocumentsSchema,
} from "./schemas.js";
export type { PaperlessDocument, PaperlessLookups } from "./types.js";

export default defineProvider<PaperlessContext>({
  provider: { id: "paperless", name: "Paperless-ngx" },
  authType: "api-key",
  credentials: paperlessCredentialsSpec,

  // Offline, from the stored credentials: the collector derives its
  // instances from discover() alone. The account id names a user on an
  // instance, which is no platform identity the people graph knows.
  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map((id) => ({
      id: String(id),
      subject: { kind: "opaque" as const, value: String(id) },
    }));
  },

  authenticate(session) {
    return paperlessAuthenticate(session);
  },

  async cleanupCredentials(accountId: string, ctx) {
    await cleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, dataCutoff, host }) {
    const { baseUrl, token } = await loadConnection(accountId, host?.configDir);
    return {
      client: new PaperlessClient(baseUrl, token),
      accountId,
      dataCutoff,
      configDir: host?.configDir,
    };
  },

  credentialState(ctx) {
    // Offline: Paperless tokens do not expire, so a stored token means
    // connected. A probe here could only add false negatives — a NAS asleep
    // would park the source in needs-auth — and the real error surfaces on
    // the next sync either way.
    return readConnectionState(async () => {
      if (!hasCredentials(String(ctx.accountId), ctx.configDir)) {
        return { status: "never-connected" };
      }
      const fields = await readProviderAccountCredentials(
        PAPERLESS_FILE_KEY,
        String(ctx.accountId),
        ctx.configDir,
      );
      if (!fields?.api_token || !fields.base_url) {
        throw new Error("Unreadable Paperless-ngx credential");
      }
      return { status: "connected" };
    });
  },

  async disposeContext() {
    // Stateless HTTP client — nothing to clean up.
  },

  sources: [
    {
      id: "paperless-documents",
      name: "Paperless-ngx",
      description:
        "Scanned and archived documents from a self-hosted Paperless-ngx — full OCR text, correspondents, document types, tags, custom fields and notes",
      unitName: "documents",
      primaryCount: "documents",
      icon: paperlessIcon,
      // Not yet run against enough real archives to trust by default.
      experimental: true,
      analyticsSchemas: allSchemas,
      documentEventProfile: paperlessDocumentEventProfile,
      contract: {
        apiVersion: 2,
        state: paperlessDocumentsStateSpec,
        requires: ["state-envelope"],
      },
      // No `urlPatterns`: a document's address is on the operator's own host,
      // and a pattern that matched `/documents/<id>/details` on any host would
      // resolve other sites' links to Paperless documents.
      async create({ sourceId, providerId, dataCutoff, accountId }, ctx) {
        const source = new PaperlessDocumentsSource(
          ctx.client,
          providerId,
          sourceId,
          accountId,
          dataCutoff,
        );
        return {
          sync: () => Promise.resolve(emptySync()),
          syncStructured: (cursor, opts) =>
            source.syncStructured(validatePaperlessDocumentsCursor(cursor), opts),
          analyticsSchemas: allSchemas,
        };
      },
    },
  ],
});
