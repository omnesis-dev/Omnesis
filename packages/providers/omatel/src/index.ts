// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  config as configSchema,
  defineProvider,
  emptySync,
  probeFileReadAccess,
} from "@omnesis/source-sdk";
import { syncCalls } from "./calls.js";
import { omatelCallsDocumentProfile, omatelMessagesDocumentProfile } from "./document-profiles.js";
import { isOmatelCursor } from "./group-sync.js";
import { omatelCallsIcon, omatelMessagesIcon } from "./icons.js";
import { syncMessages } from "./messages.js";
import { omatelCallLogSchema, omatelMessagesSchema } from "./schemas.js";
import { omatelStateSpec } from "./state.js";
import { CALLS_STORE, defaultDataDir, MESSAGES_STORE } from "./store.js";

export { syncCalls, buildCallDay } from "./calls.js";
export { syncMessages, buildConversationDay } from "./messages.js";
export { defaultDataDir } from "./store.js";

/** The configured data folder, or this phone's own. */
function dataDirOf(config: Record<string, unknown> | undefined): string {
  const configured = config?.dataDir;
  return typeof configured === "string" && configured ? configured : defaultDataDir();
}

interface OmatelContext {
  dataCutoff?: string;
  phoneRegion?: string;
}

/**
 * The folder holding omatel's stores. Member-scoped: it names a folder on one
 * phone, and another phone hosting the source has its own.
 */
const omatelConfig = configSchema.object({
  dataDir: configSchema.path({
    label: "omatel data folder",
    scope: "member",
    // Not a setup question: omatel keeps its stores in one place.
    advanced: true,
    mustExist: "directory",
    help: "Leave blank to use this phone's own folder ($XDG_DATA_HOME/omatel, or ~/.local/share/omatel)",
  }),
});

export default defineProvider<OmatelContext>({
  provider: { id: "omatel", name: "Omamobile" },
  authType: "local",
  supportedPlatforms: ["linux"],
  // Each phone keeps its own messages and calls; two phones never hold the
  // same store.
  multiDevice: { mode: "partitioned" },
  singleInstance: true,
  // Read from the stores of Phone and Messages on Omamobile, whose modem
  // support is still coming up; not yet run against a phone on a network.
  experimental: true,

  async discover() {
    if (process.platform !== "linux") return [];
    const dir = defaultDataDir();
    return existsSync(join(dir, MESSAGES_STORE.file)) || existsSync(join(dir, CALLS_STORE.file))
      ? ["local"]
      : [];
  },

  async createContext({ dataCutoff, host }) {
    return { dataCutoff, phoneRegion: host?.ingestion?.phoneRegion };
  },

  // A local store has no credential to renew; the sync path reports the
  // concrete local problem.
  async credentialState() {
    return existsSync(defaultDataDir())
      ? { status: "connected" }
      : { status: "unknown", because: "no omatel data folder on this device" };
  },

  sources: [
    {
      id: "omatel-messages",
      name: "Omamobile Messages",
      description: "SMS and MMS conversations from the Messages app on an Omamobile phone",
      unitName: "messages",
      // The unit is a message: one analytics row each, while documents are
      // conversation days.
      primaryCount: "analytics",
      icon: omatelMessagesIcon,
      conversational: true,
      contract: { state: omatelStateSpec, apiVersion: 2, requires: ["state-envelope"] },
      documentEventProfile: omatelMessagesDocumentProfile,
      analyticsSchemas: [omatelMessagesSchema],
      config: omatelConfig,
      async create({ sourceId, providerId, config }, ctx) {
        const dataDir = dataDirOf(config);
        const dbPath = join(dataDir, MESSAGES_STORE.file);
        const options = {
          dataDir,
          sourceId,
          providerId,
          dataCutoff: ctx.dataCutoff,
          phoneRegion: ctx.phoneRegion,
        };
        return {
          analyticsSchemas: [omatelMessagesSchema],
          probeReadAccess: (opts) => probeFileReadAccess(dbPath, opts),
          watchPaths: [dbPath, `${dbPath}-wal`],
          sync: () => Promise.resolve(emptySync()),
          syncStructured: async (cursor) =>
            syncMessages(isOmatelCursor(cursor) ? cursor : null, options),
        };
      },
    },
    {
      id: "omatel-calls",
      name: "Omamobile Phone",
      description: "Calls placed and received with the Phone app on an Omamobile phone",
      unitName: "calls",
      // One analytics row per call; documents are days.
      primaryCount: "analytics",
      icon: omatelCallsIcon,
      contract: { state: omatelStateSpec, apiVersion: 2, requires: ["state-envelope"] },
      documentEventProfile: omatelCallsDocumentProfile,
      analyticsSchemas: [omatelCallLogSchema],
      config: omatelConfig,
      async create({ sourceId, providerId, config }, ctx) {
        const dataDir = dataDirOf(config);
        const dbPath = join(dataDir, CALLS_STORE.file);
        const options = {
          dataDir,
          sourceId,
          providerId,
          dataCutoff: ctx.dataCutoff,
          phoneRegion: ctx.phoneRegion,
        };
        return {
          analyticsSchemas: [omatelCallLogSchema],
          probeReadAccess: (opts) => probeFileReadAccess(dbPath, opts),
          watchPaths: [dbPath, `${dbPath}-wal`],
          sync: () => Promise.resolve(emptySync()),
          syncStructured: async (cursor) =>
            syncCalls(isOmatelCursor(cursor) ? cursor : null, options),
        };
      },
    },
  ],
});
