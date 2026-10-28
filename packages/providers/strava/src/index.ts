// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  BrokerCredentialError,
  BrokeredCredentials,
  hasBrokerBinding,
  listBrokeredAccountIds,
  readBrokerBinding,
} from "@omnesis/core";
import { defineProvider, emptySync, readConnectionState } from "@omnesis/source-sdk";
import {
  authenticate as stravaAuthenticate,
  authFlow as stravaAuthFlow,
  discoverAccounts,
  hasTokens,
  loadTokens,
  cleanupCredentials as stravaCleanupCredentials,
} from "./provider.js";
import { buildBrokeredStravaClient, buildStravaClient } from "./client.js";
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

/**
 * The athlete a Strava payload names — the `athlete` of a token response, or
 * `GET /athlete` — as the sign-in here records one: its numeric id, and the
 * first and last name joined for display.
 */
function athleteIdentity(value: unknown): { id: number; name?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { id, firstname, lastname } = value as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return undefined;
  const name = [firstname, lastname]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join(" ")
    .trim();
  return name ? { id, name } : { id };
}

export default defineProvider<StravaContext>({
  provider: { id: "strava", name: "Strava" },
  authType: "oauth",
  credentials: stravaCredentialsSpec,

  broker: {
    fileKey: "strava",
    purposes: [{ id: "default", label: "Strava", brokerProviders: ["strava", "strava-web"] }],
    // The sign-in here stores an athlete under the id Strava's token response
    // names. The broker keeps that response, but a refresh answers without
    // the `athlete`, and the broker keeps the latest one — so once the grant
    // has been refreshed the athlete is asked of `/athlete` instead. The name
    // is recorded beside the binding, as the sign-in records it beside the
    // tokens, for the documents that show whose activities they are.
    async resolveAccount(credentials) {
      const { credential } = await credentials.get();
      const raw = credential.type === "oauth2" ? credential.raw : {};
      const athlete =
        athleteIdentity(raw.athlete) ??
        athleteIdentity(await buildBrokeredStravaClient(credentials).getAthleteDetail());
      if (!athlete)
        throw new Error("Strava did not say which athlete the broker's connection holds");
      const params: Record<string, string> = athlete.name ? { athleteName: athlete.name } : {};
      return { accountId: String(athlete.id), params };
    },
  },

  async discover(ctx) {
    const ids = new Set(discoverAccounts(ctx?.configDir).map(String));
    for (const id of listBrokeredAccountIds("strava", ctx?.configDir)) ids.add(id);
    return [...ids];
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

  // Local state only — the athlete's directory, which holds the tokens or,
  // for a brokered athlete, the binding. Strava is never asked to deauthorize:
  // a brokered grant is shared with other software.
  async cleanupCredentials(accountId: string, ctx) {
    await stravaCleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, dataCutoff, host }) {
    const configDir = host?.configDir;
    if (hasBrokerBinding("strava", accountId, configDir)) {
      // The account id is the athlete id, as the sign-in here stores it.
      const athleteId = Number(accountId);
      if (!Number.isSafeInteger(athleteId) || athleteId <= 0) {
        throw new Error(`Strava account ${accountId} is not an athlete id`);
      }
      const credentials = await BrokeredCredentials.load("strava", accountId, configDir, {
        // A token response that names its athlete must name this one: a
        // connection re-authorised at the broker as someone else would
        // otherwise sync their activities under this athlete's id.
        verify: (_purpose, { credential }) => {
          const named = athleteIdentity(
            credential.type === "oauth2" ? credential.raw.athlete : undefined,
          );
          if (named && named.id !== athleteId) {
            throw new BrokerCredentialError(
              "identity-changed",
              `The broker's Strava connection now belongs to another athlete, not ${accountId}; link it again with \`omnesis broker link\``,
            );
          }
        },
      });
      return {
        client: buildBrokeredStravaClient(credentials),
        accountId,
        dataCutoff,
        athleteId,
        athleteName: credentials.binding.params?.athleteName || undefined,
        configDir,
      };
    }
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
      if (hasBrokerBinding("strava", ctx.accountId, ctx.configDir)) {
        // The broker holds the grant and refreshes it; a binding that reads
        // is the stored answer. A connection the broker has lost surfaces on
        // the next sync as an `auth` failure.
        await readBrokerBinding("strava", ctx.accountId, ctx.configDir);
        return { status: "connected" };
      }
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
      // A sync that finds nothing new still costs a read: the listing. On a day
      // a backlog spends enrichment's share of a new app's 1,000 daily reads,
      // listing has the 100 between that share and its own cap to itself
      // (`ENRICHMENT_SAFETY_PCT`). This interval spends 48 of them, where the
      // collector's 5-minute default would want 288. A first import is bound by
      // the daily limit, not by how often a sync starts. Applied when a source
      // is added; one added earlier keeps its interval.
      defaultSyncInterval: "30m",
      unitName: "activities",
      // Splits, laps, best efforts, kudos and the rest are analytics rows of
      // their own, so a count over every table reads as several times the
      // number of activities. The headline stays on the activity documents.
      primaryCount: "documents",
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
