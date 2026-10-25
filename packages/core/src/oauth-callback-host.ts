// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Local OAuth listeners stay on loopback unless the operator explicitly exposes
 * them for container port forwarding. This changes the bind address only:
 * providers retain their registered redirect URI and validate OAuth state.
 * Publish forwarded callback ports on the Docker host's loopback interface.
 */
export function oauthCallbackHost(
  loopbackHost: "localhost" | "127.0.0.1" = "localhost",
): "localhost" | "127.0.0.1" | "0.0.0.0" {
  const host = process.env.OMNESIS_OAUTH_CALLBACK_HOST;
  if (!host) return loopbackHost;
  if (host === "localhost" || host === "127.0.0.1") return host;
  if (host === "0.0.0.0") return host;
  throw new Error("OMNESIS_OAUTH_CALLBACK_HOST must be localhost, 127.0.0.1, or 0.0.0.0");
}
