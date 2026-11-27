// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { writeProviderAccountCredentials } from "@omnesis/core";
import { defineProvider, emptySync, readConnectionState } from "@omnesis/source-sdk";
import { PlaudClient } from "./client.js";
import { plaudCredentialsSpec } from "./credentials-spec.js";
import { plaudDocumentEventProfile } from "./document-event-profile.js";
import { plaudIcon } from "./icons.js";
import {
  authenticate as plaudAuthenticate,
  cleanupCredentials,
  connectionFields,
  discoverAccounts,
  hasCredentials,
  loadConnection,
  PLAUD_FILE_KEY,
} from "./provider.js";
import { PlaudRecordingsSource } from "./recordings.js";
import { plaudRecordingsStateSpec } from "./state.js";
import { fileTranscriptCache } from "./transcript-cache.js";
import { validatePlaudRecordingsCursor } from "./types.js";
import type { PlaudContext } from "./types.js";

export { PlaudClient } from "./client.js";
export { plaudCredentialsSpec } from "./credentials-spec.js";
export { PlaudRecordingsSource } from "./recordings.js";
export { recordingToDocument } from "./normalizer.js";

export default defineProvider<PlaudContext>({
  provider: { id: "plaud", name: "Plaud" },
  authType: "api-key",
  credentials: plaudCredentialsSpec,
  // The API is the one Plaud's own web app uses, not a published one, and
  // it has not yet been exercised against a real account end to end.
  experimental: true,

  // Offline, from the stored sign-ins: the collector derives its instances
  // from discover() alone. The account is the address it signed in with.
  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map((id) => ({
      id: String(id),
      subject: { kind: "email" as const, value: String(id) },
    }));
  },

  authenticate(session) {
    return plaudAuthenticate(session);
  },

  async cleanupCredentials(accountId: string, ctx) {
    await cleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, dataCutoff, host }) {
    const configDir = host?.configDir;
    const connection = await loadConnection(accountId, configDir);
    const now = host ? () => host.now() : () => new Date();
    const client = new PlaudClient(connection.apiBase, connection.tokens, {
      nowSeconds: () => Math.floor(now().getTime() / 1000),
      // A renewed token replaces the stored one, so the next run starts from it.
      onTokens: (tokens) =>
        writeProviderAccountCredentials(
          PLAUD_FILE_KEY,
          accountId,
          connectionFields({ ...connection, tokens }),
          configDir,
        ),
    });
    return { client, accountId, email: connection.email, dataCutoff, configDir, now };
  },

  credentialState(ctx) {
    // Offline: a stored sign-in means connected until the end Plaud gave it,
    // which renewals never move. Whether Plaud still honours it before then
    // surfaces on the next sync as an `auth` failure, which a probe here
    // could only anticipate with false negatives during an outage.
    return readConnectionState(async () => {
      if (!hasCredentials(String(ctx.accountId), ctx.configDir)) {
        return { status: "never-connected" };
      }
      const { tokens } = await loadConnection(String(ctx.accountId), ctx.configDir);
      if (tokens.sessionExpiresAt === undefined) return { status: "connected" };
      const at = new Date(tokens.sessionExpiresAt * 1000).toISOString();
      return tokens.sessionExpiresAt * 1000 <= ctx.now().getTime()
        ? { status: "expired", at }
        : { status: "connected", expiresAt: at };
    });
  },

  async disposeContext() {
    // Stateless HTTP client — nothing to clean up.
  },

  sources: [
    {
      id: "plaud-recordings",
      name: "Plaud",
      description:
        "Recordings from Plaud voice recorders — one conversation per recording, transcribed by your own transcriber (or Plaud's transcript when none is available), with Plaud's summary",
      unitName: "recordings",
      icon: plaudIcon,
      conversational: true,
      // Each sync lists every recording, and Plaud publishes no rate limits
      // for an API it does not offer to third parties: poll gently.
      defaultSyncInterval: "30m",
      documentEventProfile: plaudDocumentEventProfile,
      contract: {
        state: plaudRecordingsStateSpec,
        requires: ["state-envelope"],
      },
      // No analytics tables: recordings land as documents through
      // syncStructured(). The empty array is what makes the collector call it.
      analyticsSchemas: [],
      // No `urlPatterns`: Plaud's web app addresses for a recording are not
      // documented, and a guessed pattern would resolve unrelated links.
      async create({ sourceId, providerId, dataCutoff, host }, ctx) {
        const source = new PlaudRecordingsSource(
          ctx.client,
          providerId,
          sourceId,
          ctx.email,
          dataCutoff,
          host?.transcribeAudio,
          host ? { transcripts: fileTranscriptCache(host.stateDir, host.configDir) } : {},
        );
        return {
          sync: () => Promise.resolve(emptySync()),
          syncStructured: (cursor, opts) =>
            source.syncStructured(validatePlaudRecordingsCursor(cursor), opts),
          analyticsSchemas: [],
        };
      },
    },
  ],
});
