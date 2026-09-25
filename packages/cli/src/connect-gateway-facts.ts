// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the gateway on the other end is, and recording it for the plugin.
 *
 * `omnesis connect` has to ask three questions before it changes anything on
 * a harness machine: is this an Omnesis gateway new enough to install
 * against, does it offer Watch management, and is the plugin about to be
 * installed the same product version. The answers decide what the generated
 * skill says and which tools the installed plugin registers, so they are also
 * written into the integration's own credential file — a plugin process may
 * have to choose its tool set before it has ever reached a gateway.
 *
 * The order those facts are written in matters, and is the reason trust and
 * capability are separate functions here rather than one. See each.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  agentIntegrationVersion,
  describeVersionDrift,
  IntegrationHttpError,
  loadIntegrationCredentials,
  parseGatewayCapabilities,
  PinnedGatewayHttpClient,
  subscriptionsAvailable,
  updateIntegrationCapabilities,
  writeIntegrationCredentials,
  type GatewayCapabilities,
  type IntegrationCredentials,
  type TlsTrust,
} from "@omnesis/agent-integration";

import { c, CliError, EXIT_USER_ERROR } from "./utils.js";
import type { Harness, HarnessSkillCapabilities } from "./harness-skills.js";

/**
 * Ask the gateway what it is and what it offers, before anything is written.
 *
 * A harness has no token yet, which is why `/health` is public. Two things
 * come back that change what gets installed: the product version, so a plugin
 * packed from a mismatched checkout says so out loud instead of failing
 * strangely later, and whether Watch management exists at all — the half of
 * this integration that still ships behind the Watch runtime's gate, and the
 * one the skill and the registered tool set have to agree about.
 */
export async function readIntegrationCapabilities(
  gatewayUrl: string,
  tls?: TlsTrust,
): Promise<GatewayCapabilities> {
  let capabilities: GatewayCapabilities;
  try {
    // A harness has no token yet, which is why `/health` is public. `/status`
    // stays read-scoped and is never reached from here.
    capabilities = parseGatewayCapabilities(
      await new PinnedGatewayHttpClient(gatewayUrl, "", tls).requestJson("GET", "/health"),
    );
  } catch (error) {
    const detail =
      error instanceof IntegrationHttpError
        ? `gateway returned HTTP ${error.status}`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new CliError(
      `${c.red}Could not reach the Omnesis gateway to read its capabilities (${detail}); ` +
        `no harness files were changed.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (capabilities.watchPrivacyPolicy !== 1) {
    throw new CliError(
      `${c.red}This gateway must be upgraded before installing the current ${
        c.bold
      }Omnesis agent integration${c.reset}. Upgrade and restart the gateway, then retry; ` +
        `no harness files were changed.`,
      EXIT_USER_ERROR,
    );
  }
  return capabilities;
}

/**
 * Say so when the plugin about to be installed and the gateway it will talk to
 * are different product versions. Omnesis versions in lockstep, and the plugin
 * is packed from whichever `@omnesis/agent-integration` sits beside this CLI —
 * a machine that upgrades on its own schedule. A warning, never a refusal: the
 * protocol version is the only accept-or-reject gate.
 */
export function warnOnVersionDrift(capabilities: GatewayCapabilities, harness: Harness): void {
  const drift = describeVersionDrift(agentIntegrationVersion(), capabilities.version, harness);
  if (drift.warning) console.log(`${c.yellow}${drift.warning}${c.reset}`);
}

/**
 * Re-pin the certificate this installation will present to the gateway.
 *
 * Written before the plugin is installed, because the OAuth round-trip that
 * follows has to be made over the certificate actually in front of us — a
 * rotation during `--refresh` would otherwise leave the saved pin naming one
 * that no longer exists. `tls` is an old field: every shipped plugin already
 * understands it.
 */
export function persistGatewayTrust(
  credentialsPath: string,
  credentials: IntegrationCredentials,
  tls: TlsTrust | undefined,
): IntegrationCredentials {
  if (
    credentials.tls?.leafFingerprintSha256 === tls?.leafFingerprintSha256 &&
    credentials.tls?.caPem === tls?.caPem
  ) {
    return credentials;
  }
  const next: IntegrationCredentials = { ...credentials, ...(tls ? { tls } : {}) };
  // A gateway reached over plain loopback carries no pin at all, so an
  // installation that moved off HTTPS must lose the stale one rather than
  // keep presenting it.
  if (!tls) delete next.tls;
  writeIntegrationCredentials(credentialsPath, next);
  return next;
}

/**
 * Record what the gateway said it can do, for the plugin to read back.
 *
 * Deliberately the last thing written, after the plugin on disk is the one
 * that shipped with this CLI. `capabilities` is a field older plugins do not
 * know, and both loaders reject a credential file carrying an unknown key —
 * so writing it while the previous plugin is still installed would leave an
 * installation that cannot read its own credentials if anything later in the
 * ceremony failed.
 */
export function persistGatewayCapabilities(
  credentialsPath: string,
  capabilities: HarnessSkillCapabilities,
): void {
  if (!existsSync(credentialsPath)) return;
  if (
    subscriptionsAvailable(loadIntegrationCredentials(credentialsPath)) ===
    capabilities.subscriptions
  ) {
    return;
  }
  updateIntegrationCapabilities(credentialsPath, { subscriptions: capabilities.subscriptions });
}

/**
 * The capability the installed integration was last told about. Used where
 * there is no gateway to ask — `--skill-only` rewrites the skill offline, and
 * it must not silently change which tools the skill describes.
 */
export function installedSubscriptionsCapability(home: string): boolean {
  const path = join(home, "omnesis", "integration.json");
  if (!existsSync(path)) return true;
  try {
    return subscriptionsAvailable(loadIntegrationCredentials(path));
  } catch {
    return true;
  }
}
