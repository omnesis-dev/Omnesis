// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineProvider, emptySync, readConnectionState } from "@omnesis/source-sdk";
import {
  BrokeredCredentials,
  hasBrokerBinding,
  listBrokeredAccountIds,
  readBrokerBinding,
  readProviderAccountOrLegacyCredentials,
} from "@omnesis/core";
import { GranolaClient } from "./client.js";
import {
  authenticate as granolaAuthenticate,
  authFlow as granolaAuthFlow,
  cleanupCredentials as granolaCleanupCredentials,
  discoverAccounts,
  isKeyFingerprintAccount,
  hasCredentials,
  loadApiKey,
  resolveBrokeredAccount,
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

  /**
   * Granola through the credential broker: a personal API key held by Nango's
   * `granola` integration (API_KEY, the `grn_…` key in `apiKey`).
   */
  broker: {
    fileKey: "granola",
    purposes: [{ id: "default", label: "Granola", brokerProviders: ["granola"] }],
    resolveAccount: (credentials) => resolveBrokeredAccount(credentials),
  },

  // Resolve the authenticated account offline from the marker dir authFlow
  // writes. The collector's provider-instantiation path derives accounts
  // from discover() alone, so this must return them or the source is skipped.
  // An account is either the key owner's email or, for a workspace with no
  // notes yet, a fingerprint of the key (see `deriveAccountId`). The provider
  // builds both forms, so it tells them apart by its own format rather than by
  // looking for an `@`.
  async discover(ctx) {
    const ids = new Set(discoverAccounts(ctx?.configDir).map(String));
    for (const id of listBrokeredAccountIds("granola", ctx?.configDir)) ids.add(id);
    return [...ids].map((id) => ({
      id,
      subject: {
        kind: isKeyFingerprintAccount(id) ? ("opaque" as const) : ("email" as const),
        value: id,
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
    let client: GranolaClient;
    if (hasBrokerBinding("granola", accountId, host?.configDir)) {
      // Asked of the broker per request and never written down: the binding
      // is all this account keeps on disk.
      const credentials = await BrokeredCredentials.load("granola", accountId, host?.configDir);
      client = new GranolaClient(() => credentials.token(), {
        invalidateApiKey: () => credentials.invalidate(),
      });
    } else {
      // Keyed by account: every instance previously loaded whatever key the
      // shared file held, so a second account would have synced the first's data.
      client = new GranolaClient(await loadApiKey(accountId, host?.configDir));
    }
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
      if (hasBrokerBinding("granola", String(ctx.accountId), ctx.configDir)) {
        // The broker holds the key; a binding that reads is the stored answer.
        // A connection the broker has lost surfaces on the next sync as an
        // `auth` failure.
        await readBrokerBinding("granola", String(ctx.accountId), ctx.configDir);
        return { status: "connected" };
      }
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
