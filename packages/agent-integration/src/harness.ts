// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** The agent harnesses the managed integration is installed into. */
export type IntegrationHarness = "openclaw" | "hermes";

const HARNESS_CLIENT_NAMES: Readonly<Record<IntegrationHarness, string>> = {
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

/**
 * The OAuth client name a harness registers with the gateway.
 *
 * The gateway fills in a new connection's name from the registered client's
 * name, and uses that name, with the client id and the paired device, to
 * suggest which existing connection a returning integration replaces. It
 * never joins a connection on the name alone: a refresh that needs a new
 * approval is suggested as a replacement of the existing connection. So the
 * name is the harness's product name, and each harness registers its own.
 */
export function harnessClientName(harness: IntegrationHarness): string {
  return HARNESS_CLIENT_NAMES[harness];
}
