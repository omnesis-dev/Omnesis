// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineProvider, emptySync, readConnectionState } from "@omnesis/source-sdk";
import {
  authenticate as stravaAuthenticate,
  authFlow as stravaAuthFlow,
  discoverAccounts,
  hasTokens,
  loadTokens,
  cleanupCredentials as stravaCleanupCredentials,
} from "./provider.js";
import { buildStravaClient } from "./client.js";
import { StravaActivitiesSource } from "./activities.js";
import { stravaIcon, stravaAttribution } from "./icons.js";
import { allSchemas } from "./schemas.js";
import { stravaActivitiesStateSpec } from "./state.js";
import { validateStravaActivitiesCursor } from "./types.js";
import { stravaCredentialsSpec } from "./credentials-spec.js";
import type { StravaContext } from "./types.js";

export { StravaClient } from "./client.js";
export { StravaActivitiesSource } from "./activities.js";
export { stravaCredentialsSpec } from "./credentials-spec.js";

export default defineProvider<StravaContext>({
  provider: { id: "strava", name: "Strava" },
  authType: "oauth",
  credentials: stravaCredentialsSpec,

  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map(String);
  },

  async authFlow(_params, callbacks, ctx) {
    const accountId = await stravaAuthFlow({
      callbacks,
      onAuthUrl: callbacks?.onAuthUrl,
      configDir: ctx?.configDir,
    });
    return String(accountId);
  },

  authenticate(session) {
    return stravaAuthenticate(session);
  },

  async cleanupCredentials(accountId: string, ctx) {
    await stravaCleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, dataCutoff, host }) {
    const configDir = host?.configDir;
    const tokens = await loadTokens(accountId, configDir);
    const client = await buildStravaClient({ tokens, configDir });
    const athleteName =
      [tokens.athlete_firstname, tokens.athlete_lastname]
        .filter((s): s is string => Boolean(s))
        .join(" ")
        .trim() || undefined;
    return {
      client,
      accountId,
      dataCutoff,
      athleteId: tokens.athlete_id,
      athleteName,
      configDir,
    };
  },

  credentialState(ctx) {
    // Offline: a stored grant means authenticated. A live probe here cannot
    // tell "Strava is unreachable right now" from "the athlete disconnected
    // us", so one failed request would park every Strava source in needs-auth
    // and push a re-auth reminder that the credentials never warranted. A
    // grant that really has been revoked surfaces on the next token refresh
    // as a typed `auth` sync error, which is the signal that can be trusted.
    // A stored credential is the whole answer, and its absence means this
    // account was never connected rather than that something withdrew it —
    // the remedy differs: one asks the operator to connect, the other to
    // authenticate again.
    return readConnectionState(async () => {
      if (!hasTokens(ctx.accountId, ctx.configDir)) return { status: "never-connected" };
      const tokens = await loadTokens(ctx.accountId, ctx.configDir);
      if (!tokens.access_token || !tokens.refresh_token) throw new Error("Unreadable Strava token");
      return { status: "connected" };
    });
  },

  async disposeContext() {
    // No persistent connections to clean up.
  },

  sources: [
    {
      id: "strava-activities",
      name: "Strava Activities",
      description:
        "Runs, rides, swims, and other workouts from Strava — with description, splits, best efforts, comments, kudos, zones, streams",
      unitName: "activities",
      icon: stravaIcon,
      attribution: stravaAttribution,
      analyticsSchemas: allSchemas,
      contract: {
        // The host resolves the stored cursor against this before
        // `syncStructured` runs. See `state.ts` for what a lost cursor costs
        // here and why that cost picks `onUnreadable: "stop"`.
        state: stravaActivitiesStateSpec,
        // Declared because the chosen "stop" policy is a materially different
        // outcome from an older host's default behaviour (a silent restart).
        // A host without envelope support would hand the raw stored value to
        // the same phase-set validator this source already ran, which reads
        // as a first run — declaring the dependency makes that host refuse
        // the package instead of quietly losing the protection.
        requires: ["state-envelope"],
      },
      // The Strava normalizer tags the athlete's own profile with the LID
      // `strava-athlete:<numeric athlete id>` (see normalizer.ts). Declaring
      // it here lets the gateway pair this source's account to the self
      // person without naming "strava" in shared code. Restricted to numeric
      // accounts so a placeholder/non-id account never claims a self alias.
      selfIdentity: { aliasPrefix: "strava-athlete", accountPattern: "^\\d+$" },
      urlPatterns: [{ regex: "strava\\.com/activities/(\\d+)", idGroup: 1 }],
      async create({ sourceId, providerId, dataCutoff, host }, ctx) {
        const source = new StravaActivitiesSource(
          ctx.client,
          sourceId,
          providerId,
          dataCutoff,
          ctx.athleteName,
          ctx.athleteId,
          host?.analytics,
        );
        return {
          sync: () => Promise.resolve(emptySync()),
          syncStructured: (cursor) => source.syncStructured(validateStravaActivitiesCursor(cursor)),
          analyticsSchemas: allSchemas,
        };
      },
    },
  ],
});
