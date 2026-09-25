// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineProvider, emptySync, readConnectionState } from "@omnesis/source-sdk";
import { readProviderAccountOrLegacyCredentials } from "@omnesis/core";
import { GranolaClient } from "./client.js";
import {
  authenticate as granolaAuthenticate,
  authFlow as granolaAuthFlow,
  cleanupCredentials as granolaCleanupCredentials,
  discoverAccounts,
  isKeyFingerprintAccount,
  hasCredentials,
  loadApiKey,
} from "./provider.js";
import { granolaCredentialsSpec } from "./credentials-spec.js";
import { granolaIcon } from "./icons.js";
import { allSchemas, granolaMeetingsSchema } from "./schemas.js";
import { GranolaMeetingsSource } from "./meetings.js";
import { granolaMeetingsStateSpec } from "./state.js";
import { validateGranolaMeetingsCursor } from "./types.js";
import type { GranolaContext } from "./types.js";

export { GranolaClient } from "./client.js";
export { granolaCredentialsSpec } from "./credentials-spec.js";
export { granolaMeetingsSchema, allSchemas } from "./schemas.js";
export { GranolaMeetingsSource } from "./meetings.js";
export { noteToRecord, noteToDocument } from "./normalizer.js";
export type { GranolaNoteDetail } from "./types.js";

export default defineProvider<GranolaContext>({
  provider: { id: "granola", name: "Granola" },
  authType: "api-key",
  credentials: granolaCredentialsSpec,

  // Resolve the authenticated account offline from the marker dir authFlow
  // writes. The collector's provider-instantiation path derives accounts
  // from discover() alone, so this must return them or the source is skipped.
  // An account is either the key owner's email or, for a workspace with no
  // notes yet, a fingerprint of the key (see `deriveAccountId`). The provider
  // builds both forms, so it tells them apart by its own format rather than by
  // looking for an `@`.
  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map((id) => ({
      id: String(id),
      subject: {
        kind: isKeyFingerprintAccount(String(id)) ? ("opaque" as const) : ("email" as const),
        value: String(id),
      },
    }));
  },

  authenticate(session) {
    return granolaAuthenticate(session);
  },

  async authFlow(params, callbacks, ctx) {
    // The pasted API key arrives on `callbacks.credentials` for a new add and
    // is read from disk for a re-auth. No browser leg for an api-key source.
    const accountId = await granolaAuthFlow(params, callbacks, ctx);
    return String(accountId);
  },

  async cleanupCredentials(accountId: string, ctx) {
    await granolaCleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, dataCutoff, host }) {
    // Keyed by account: every instance previously loaded whatever key the
    // shared file held, so a second account would have synced the first's data.
    const apiKey = await loadApiKey(accountId, host?.configDir);
    const client = new GranolaClient(apiKey);
    return { client, accountId, dataCutoff, configDir: host?.configDir };
  },

  credentialState(ctx) {
    // Offline: a stored key means authenticated. A network probe here can only
    // add false negatives — a lapsed subscription or a rate limit would park
    // the source in needs-auth and prompt a re-auth that cannot resolve it —
    // and the real error surfaces on the next sync either way.
    // A stored credential is the whole answer, and its absence means this
    // account was never connected rather than that something withdrew it —
    // the remedy differs: one asks the operator to connect, the other to
    // authenticate again.
    return readConnectionState(async () => {
      if (!hasCredentials(String(ctx.accountId), ctx.configDir))
        return { status: "never-connected" };
      const fields = await readProviderAccountOrLegacyCredentials(
        "granola",
        String(ctx.accountId),
        ctx.configDir,
      );
      if (!fields?.api_key) throw new Error("Unreadable Granola credential");
      return { status: "connected" };
    });
  },

  async disposeContext() {
    // Stateless HTTP client — nothing to clean up.
  },

  sources: [
    {
      id: "granola-meetings",
      name: "Granola Meetings",
      description:
        "Meeting notes from Granola — AI summaries and full transcripts, searchable, with a structured meetings table (who, when, duration, attendees)",
      unitName: "meetings",
      icon: granolaIcon,
      analyticsSchemas: allSchemas,
      contract: {
        // The host resolves the stored cursor against this before
        // `syncStructured` runs, so a value from a build that could not read
        // it never reaches the source.
        state: granolaMeetingsStateSpec,
        requires: ["state-envelope"],
      },
      urlPatterns: [{ regex: "granola\\.(?:ai|so)/notes/(not_[a-zA-Z0-9]+)", idGroup: 1 }],
      async create({ sourceId, providerId, dataCutoff, accountId }, ctx) {
        const source = new GranolaMeetingsSource(
          ctx.client,
          providerId,
          sourceId,
          dataCutoff,
          accountId,
        );
        return {
          sync: () => Promise.resolve(emptySync()),
          syncStructured: (cursor) => source.syncStructured(validateGranolaMeetingsCursor(cursor)),
          analyticsSchemas: [granolaMeetingsSchema],
        };
      },
    },
  ],
});
