// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";

/** Public SNI identity is separate from the certificate existing direct devices pin. */
export function publicGatewayCertificateFile(env: NodeJS.ProcessEnv): string {
  return z
    .string()
    .min(1)
    .parse(env.OMNESIS_ACME_DIRECTORY_URL ? env.OMNESIS_ACME_CERT_FILE : env.OMNESIS_TLS_CERT);
}

/** Public TLS renewal has its own stable private key, independent of direct TLS renewal. */
export function publicGatewayPrivateKeyFile(env: NodeJS.ProcessEnv): string {
  return z
    .string()
    .min(1)
    .parse(
      env.OMNESIS_ACME_DIRECTORY_URL
        ? (env.OMNESIS_ACME_KEY_FILE ?? `${publicGatewayCertificateFile(env)}.key`)
        : env.OMNESIS_TLS_KEY,
    );
}

/** Relay enrollment can use a distinct public hostname without replacing an existing MCP issuer. */
export function publicGatewayOrigin(env: NodeJS.ProcessEnv): string {
  return bindingOrigin(
    z
      .string()
      .min(1)
      .parse(env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN ?? env.OMNESIS_PUBLIC_BASE_URL),
  ).origin;
}
