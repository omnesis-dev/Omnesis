// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { DEFAULT_CONFIG_DIR, createLogger } from "@omnesis/core";
import { defineProvider, emptySync, readConnectionState } from "@omnesis/source-sdk";
import {
  authenticate as notionAuthenticate,
  discoverAccounts,
  authFlow as notionAuthFlow,
  hasTokens,
  loadTokens,
} from "./provider.js";
import { NotionClient } from "./client.js";
import { NotionPagesSource } from "./pages.js";
import { NotionDatabasesSource } from "./databases.js";
import { notionIcon, notionDatabaseIcon } from "./icons.js";
import { notionPagesDocumentProfile, notionDatabasesDocumentProfile } from "./document-profiles.js";
import { validateNotionDatabasesCursor } from "./types.js";
import { notionCredentialsSpec } from "./credentials-spec.js";
import { notionPagesStateSpec, notionDatabasesStateSpec } from "./state.js";
import type { NotionContext, UserMap } from "./types.js";

export { NotionClient } from "./client.js";
export { NotionPagesSource } from "./pages.js";
export { NotionDatabasesSource } from "./databases.js";
export { notionCredentialsSpec } from "./credentials-spec.js";

const log = createLogger("provider:notion");

// ── Provider Definition ──────────────────────────────────────────────

export default defineProvider<NotionContext>({
  provider: { id: "notion", name: "Notion" },
  authType: "oauth",
  credentials: notionCredentialsSpec,

  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map(String);
  },

  async authFlow(_params, callbacks, ctx) {
    const accountId = await notionAuthFlow({
      callbacks,
      onAuthUrl: callbacks?.onAuthUrl,
      configDir: ctx?.configDir,
    });
    return String(accountId);
  },

  authenticate(session) {
    return notionAuthenticate(session);
  },

  async cleanupCredentials(accountId: string, ctx) {
    const { rm } = await import("node:fs/promises");
    const accountDir = join(ctx?.configDir ?? DEFAULT_CONFIG_DIR, "notion", accountId);
    await rm(accountDir, { recursive: true, force: true });
  },

  async createContext({ accountId, dataCutoff, host }) {
    const tokens = loadTokens(accountId, host?.configDir);
    const client = new NotionClient(tokens.access_token);

    // Build user ID → name map for author resolution
    const userMap: UserMap = new Map();
    try {
      const users = await client.listUsers();
      for (const user of users.results) {
        if ("name" in user && user.name) {
          const email = "person" in user && user.person?.email ? user.person.email : undefined;
          userMap.set(user.id, { name: user.name, email });
        }
      }
      log.info(`Resolved ${userMap.size} workspace users`);
    } catch (err) {
      log.warn(`Failed to list workspace users: ${err}`);
    }

    return { client, accountId, dataCutoff, userMap, configDir: host?.configDir };
  },

  credentialState(ctx) {
    // Offline: a stored grant means authenticated. A live probe here cannot
    // tell "Notion is unreachable right now" from "the workspace revoked the
    // integration", so one failed request would park every Notion source in
    // needs-auth and push a re-auth reminder that the credentials never
    // warranted. A revoked grant surfaces on the next sync as an `unauthorized`
    // API error, which is the signal that can be trusted.
    // A stored credential is the whole answer, and its absence means this
    // account was never connected rather than that something withdrew it —
    // the remedy differs: one asks the operator to connect, the other to
    // authenticate again.
    return readConnectionState(() => {
      if (!hasTokens(ctx.accountId, ctx.configDir)) return { status: "never-connected" };
      const tokens = loadTokens(ctx.accountId, ctx.configDir);
      if (!tokens.access_token) throw new Error("Unreadable Notion token");
      return { status: "connected" };
    });
  },

  async disposeContext() {
    // No persistent connections to clean up
  },

  sources: [
    {
      id: "notion-pages",
      name: "Notion Pages",
      description: "Pages from your Notion workspace",
      unitName: "pages",
      urlPatterns: [{ regex: "notion\\.so/[^?#]*([a-f0-9]{32})(?:[?].*|)$", idGroup: 1 }],
      // Notion's web app — `notion.so` also covers `www.notion.so` and any
      // `*.notion.so` workspace subdomain via the subdomain-match rule. Pages
      // are already ingested here, so the browser-capture source skips
      // the Notion UI.
      ownedWebDomains: ["notion.so"],
      icon: notionIcon,
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never reaches
        // `sync`.
        state: notionPagesStateSpec,
        requires: ["state-envelope"],
      },
      documentEventProfile: notionPagesDocumentProfile,
      // Notion caps API at ~3 req/s; a 30m cadence keeps us under the
      // limit across typical workspaces. The proper fix (in-cycle
      // rate-limit handling + database-list caching) is tracked separately.
      defaultSyncInterval: "30m",
      async create({ sourceId, providerId, dataCutoff }, ctx) {
        const source = new NotionPagesSource(
          ctx.client,
          sourceId,
          providerId,
          dataCutoff,
          ctx.userMap,
        );
        // Surface the icon at the runtime instance level too. The
        // collector only ships instance-level icons to the gateway's
        // sync_state.icon column — descriptor-level icons get lost.
        return { icon: notionIcon, sync: (cursor) => source.sync(cursor) };
      },
    },
    {
      id: "notion-databases",
      name: "Notion Databases",
      description: "Structured data from your Notion databases",
      unitName: "rows",
      icon: notionDatabaseIcon,
      contract: {
        // The host resolves the stored cursor against this before
        // `syncStructured` runs, so a value from a build that could not read
        // it never reaches the source.
        state: notionDatabasesStateSpec,
        // The version-1 → 2 step ends a rewalk whose accumulated ids can no
        // longer be attributed to a database. A host that ignored the
        // declaration would hand that version-1 value straight to a decoder
        // that accepts it — the rewalk would resume believing an empty
        // accumulator was everything it had read, and close by claiming only
        // the databases walked after the upgrade. Refusing the package is the
        // safe end of that.
        apiVersion: 2,
        requires: ["state-envelope", "snapshot-sessions"],
      },
      documentEventProfile: notionDatabasesDocumentProfile,
      // Dynamic schemas — each page's analytics write carries its own table's
      // schema, discovered from that database's properties at sync time.
      analyticsSchemas: [],
      // Notion databases are the worst offender for rate
      // limits because each sync enumerates databases + queries all rows.
      // 30m default buys headroom while the loop-tightening work lands.
      defaultSyncInterval: "30m",
      async create({ sourceId, providerId, dataCutoff }, ctx) {
        const source = new NotionDatabasesSource(
          ctx.client,
          sourceId,
          providerId,
          dataCutoff,
          ctx.userMap,
        );
        return {
          icon: notionDatabaseIcon,
          sync: () => Promise.resolve(emptySync()),
          syncStructured: (cursor) => source.syncStructured(validateNotionDatabasesCursor(cursor)),
          analyticsSchemas: [],
        };
      },
    },
  ],
});
