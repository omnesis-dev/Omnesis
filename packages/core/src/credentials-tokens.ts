// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `{gatewayOrigin}` template-token expansion for credentials specs.
 *
 * A provider's credentials spec is a **shared** descriptor rendered by every
 * admin client (the portal wizard and the CLI wizard). Aggregators like Enable
 * Banking require the OAuth redirect URL to match the whitelisted value
 * character-for-character, so the descriptor writes a source-agnostic
 * `{gatewayOrigin}` token (per the source-encapsulation rule — no per-source
 * host logic downstream) and each client expands it to the gateway's real
 * externally-reachable origin at render time.
 *
 * This module is the single source of truth for the token constant and the
 * expansion, so the two clients cannot drift. It is deliberately **pure and
 * dependency-free** (no `node:*`, no zod) and re-exported through the
 * browser-safe `@omnesis/core/credentials-tokens` subpath, so the portal's
 * vendored bundle can share the exact same logic the CLI runs — the same
 * pattern as `@omnesis/core/url-normalize`.
 */

import type { SerializedProviderCredentialsSpec } from "./credentials.js";

/**
 * Source-agnostic template token. A descriptor writes `{gatewayOrigin}` and a
 * client expands it to the gateway's real externally-reachable origin (scheme
 * included, e.g. `https://gw.example.com:7600`), so a redirect URL like
 * `{gatewayOrigin}/oauth/callback` becomes a ready-to-paste value that matches
 * exactly what the bank will redirect to.
 */
export const GATEWAY_ORIGIN_TOKEN = "{gatewayOrigin}";

/**
 * Resolve the gateway's externally-reachable origin. Prefers the configured
 * `gateway.publicBaseUrl`; when unset, falls back to the browser origin the
 * portal was loaded on (the host the OAuth redirect will actually land on).
 * Returns `""` when neither is available (e.g. a non-browser CLI/test
 * environment with no configured base URL) — callers render the bare token
 * rather than a wrong origin, which is at least self-descriptive.
 *
 * `publicBaseUrl` is schema-refined to reject a trailing slash and
 * `window.location.origin` never has one, so `<origin>/oauth/callback` never
 * double-slashes.
 */
export function resolveGatewayOrigin(publicBaseUrl?: string): string {
  if (publicBaseUrl) return publicBaseUrl;
  if (typeof window !== "undefined") return window.location?.origin ?? "";
  return "";
}

/** Expand every `{gatewayOrigin}` token in a string with the resolved origin. */
export function expandGatewayOriginToken(text: string, origin: string): string {
  return (text ?? "").split(GATEWAY_ORIGIN_TOKEN).join(origin);
}

/**
 * Pull `gateway.publicBaseUrl` out of a `GET /admin/config` response. That
 * endpoint wraps the config as `{ config, version }` (mirrored by the portal's
 * config view and the CLI's `AdminConfigResponse`), so the value lives one
 * level below the response root.
 */
export function publicBaseUrlFromAdminConfig(response?: {
  config?: { gateway?: { publicBaseUrl?: string } };
}): string | undefined {
  return response?.config?.gateway?.publicBaseUrl;
}

/**
 * Return a copy of the spec with `{gatewayOrigin}` expanded everywhere the
 * token contract allows it to appear: field placeholders/defaults and step
 * bodies. A spec with no token is returned structurally unchanged (every string
 * survives the no-op `split`/`join`). Whole field objects are preserved, so
 * `default`, `pattern`, `secret`, etc. round-trip untouched.
 */
export function expandSpecTokens(
  spec: SerializedProviderCredentialsSpec,
  origin: string,
): SerializedProviderCredentialsSpec {
  return {
    ...spec,
    fields: spec.fields.map((field) => ({
      ...field,
      placeholder:
        field.placeholder === undefined
          ? undefined
          : expandGatewayOriginToken(field.placeholder, origin),
      default:
        field.default === undefined ? undefined : expandGatewayOriginToken(field.default, origin),
    })),
    wizard: {
      ...spec.wizard,
      steps: spec.wizard.steps.map((step) => ({
        ...step,
        body: expandGatewayOriginToken(step.body, origin),
      })),
    },
  };
}
