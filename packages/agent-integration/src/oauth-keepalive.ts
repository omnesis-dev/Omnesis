// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keeping a harness's corpus access alive between questions.
 *
 * The OAuth credential a managed integration reads through is renewed by
 * spending its refresh token, and the gateway rotates that token on every use
 * and expires it on a timer. On its own, nothing renews it on a schedule: the
 * plugin trades it when a question needs a bearer, so an installation nobody
 * asks anything for a month would find the ticket gone. The browser redirect
 * that would replace it is the one thing an unattended plugin cannot perform,
 * so silence is the hazard this module exists to remove.
 *
 * Two mechanisms close that gap, and this module owns both halves that are
 * worth reasoning about on their own:
 *
 *   - the schedule — refresh on start, then on a slow timer once the ticket is
 *     into its last stretch, so ordinary silence never reaches the cliff; and
 *   - the recovery — when the ticket has already lapsed, trade the device's own
 *     management token for a fresh pair on the credential the operator already
 *     approved, which is the one authority an unattended plugin still holds.
 */

import { IntegrationHttpError, PinnedGatewayHttpClient } from "./http.js";
import type { IntegrationOAuthProvider } from "./oauth.js";
import type { IntegrationCredentials } from "./credentials.js";

/**
 * How long a gateway-issued refresh token lives.
 *
 * Restated here because the plugin ships standalone into a harness host and
 * imports nothing of the gateway. The guard against drift is a test, not this
 * comment: `oauth-keepalive.test.ts` reads the gateway's own declaration of
 * `REFRESH_TOKEN_TTL_MS` and fails if it moves away from this number.
 * Over-estimating is the dangerous direction — the keepalive would decide
 * there is time left on a ticket that is already gone.
 */
export const ASSUMED_REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60_000;

/**
 * How much of the ticket must remain before the keepalive leaves it alone.
 *
 * A week is comfortably longer than any restart, upgrade or outage a harness
 * host is likely to sit through, and short enough that an installation asked
 * something once a fortnight still spends nothing extra.
 */
export const REFRESH_KEEPALIVE_MARGIN_MS = 7 * 24 * 60 * 60_000;

/** How often a running service reconsiders the question. */
export const REFRESH_KEEPALIVE_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Should this installation spend its refresh token now?
 *
 * Unknown issue time counts as due: a file written before the stamp existed
 * carries a token of unknown age, and refreshing one that had plenty of life
 * left costs a single request, while skipping one that did not costs the
 * installation its corpus access until somebody notices.
 */
export function refreshKeepaliveDue(
  tokensObtainedAt: number | undefined,
  now: number,
  lifetimeMs: number = ASSUMED_REFRESH_TOKEN_LIFETIME_MS,
  marginMs: number = REFRESH_KEEPALIVE_MARGIN_MS,
): boolean {
  if (tokensObtainedAt === undefined) return true;
  // A stamp in the future is a clock that moved backwards, not a fresh token.
  if (tokensObtainedAt > now) return true;
  return now - tokensObtainedAt >= lifetimeMs - marginMs;
}

/** The gateway's reply to a re-issue, in the ordinary OAuth token shape. */
interface ReissuedTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  refresh_token?: unknown;
}

/**
 * The gateway's own code for "no approved credential is bound to this device".
 *
 * Matched rather than the bare 404 because a gateway too old to serve the
 * route answers 404 as well, and telling that operator their grant had been
 * revoked would send them to repair something that is not broken.
 */
const NO_APPROVED_CREDENTIAL = "NO_APPROVED_CREDENTIAL";

/** Raised when the operator has revoked the grant, or never approved one. */
class IntegrationReauthorizationRequiredError extends Error {
  constructor(harnessHint = "<harness>") {
    super(
      `Omnesis corpus access for this installation is no longer authorized. ` +
        `Run \`omnesis connect ${harnessHint} --refresh\` on this machine.`,
    );
    this.name = "IntegrationReauthorizationRequiredError";
  }
}

/**
 * Recover a lapsed OAuth ticket without a browser.
 *
 * The device presents the management token it was paired with — an authority
 * that cannot read the corpus itself — and the gateway re-keys the credential
 * that same device is already bound to. It cannot produce a grant nobody
 * approved: with the grant revoked the route answers 404 and this throws, and
 * the only remaining path is the interactive one it names.
 */
export async function reissueIntegrationOAuthTokens(
  provider: IntegrationOAuthProvider,
  credentials: IntegrationCredentials,
  harnessHint?: string,
): Promise<void> {
  const clientId = provider.clientInformation()?.client_id;
  if (typeof clientId !== "string" || clientId === "") {
    throw new IntegrationReauthorizationRequiredError(harnessHint);
  }
  const http = new PinnedGatewayHttpClient(
    credentials.gatewayUrl,
    credentials.managementToken,
    credentials.tls,
  );
  let response: ReissuedTokenResponse;
  try {
    response = await http.requestJson<ReissuedTokenResponse>(
      "POST",
      "/agent-integration/oauth-reissue",
      { clientId },
    );
  } catch (error) {
    if (error instanceof IntegrationHttpError && error.code === NO_APPROVED_CREDENTIAL) {
      throw new IntegrationReauthorizationRequiredError(harnessHint);
    }
    throw error;
  }
  if (typeof response.access_token !== "string" || typeof response.refresh_token !== "string") {
    throw new Error("Omnesis returned an invalid re-issue response");
  }
  provider.saveTokens({
    access_token: response.access_token,
    token_type: typeof response.token_type === "string" ? response.token_type : "Bearer",
    refresh_token: response.refresh_token,
    ...(typeof response.expires_in === "number" ? { expires_in: response.expires_in } : {}),
    ...(typeof response.scope === "string" ? { scope: response.scope } : {}),
  } as Parameters<IntegrationOAuthProvider["saveTokens"]>[0]);
}
