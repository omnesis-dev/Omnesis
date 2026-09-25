// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { bodyLimit } from "hono/body-limit";

import { BadRequestError } from "../errors.js";
import { oauthAuthorizationHandleQuery } from "../schemas/oauth-access.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Context } from "hono";
import type { AppEnv } from "./types.js";

const OAUTH_BODY_LIMIT_BYTES = 64 * 1_024;

export const noStore = async (
  c: { header: (name: string, value: string) => void },
  next: () => Promise<void>,
): Promise<void> => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  await next();
};

export function oauthError(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  error: string,
  description: string,
) {
  return c.json({ error, error_description: description }, status);
}

export function oauthConfigurationRequired(c: Context<AppEnv>) {
  return oauthError(
    c,
    503,
    "server_error",
    "OAuth requires gateway.publicBaseUrl for non-loopback access.",
  );
}

export function oauthRateLimitError(c: Context<AppEnv>) {
  c.header("Retry-After", "60");
  return oauthError(c, 429, "temporarily_unavailable", "Too many OAuth requests.");
}

export const oauthBodyLimit = bodyLimit({
  maxSize: OAUTH_BODY_LIMIT_BYTES,
  onError: (c) => oauthError(c, 413, "invalid_request", "OAuth request is too large."),
});

export function invalidClientError(c: Context<AppEnv>) {
  c.header("WWW-Authenticate", 'Basic realm="Omnesis OAuth"');
  return oauthError(c, 401, "invalid_client", "Client authentication failed.");
}

export function tokenMutationError(c: Context<AppEnv>, error: string) {
  if (error === "invalid-client" || error === "invalid-secret") return invalidClientError(c);
  if (error === "invalid-scope") {
    return oauthError(c, 400, "invalid_scope", "The requested scope is not permitted.");
  }
  if (error === "invalid-resource") {
    return oauthError(c, 400, "invalid_target", "The requested OAuth resource is not permitted.");
  }
  return oauthError(c, 400, "invalid_grant", "The OAuth grant is invalid or expired.");
}

export function validateRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestError("redirect_uris contains an invalid URL.");
  }
  if (url.hash || url.username || url.password) {
    throw new BadRequestError("redirect_uris cannot contain fragments or user information.");
  }
  // Native MCP hosts use both IP-literal and exact `localhost` loopback
  // callbacks. Hostname lookalikes and every other plain-HTTP host stay barred.
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new BadRequestError("Redirect URIs must use HTTPS or loopback HTTP.");
  }
  // Preserve the registered octets. Authorization matching is exact for web
  // redirects, so silently adding a slash here would make the client's own
  // registered value unusable.
  return value;
}

export function validateHttpsUrl(value: string, field: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new BadRequestError(`${field} must be an HTTPS URL without credentials or a fragment.`);
  }
}

export async function readOAuthForm(
  c: Context<AppEnv>,
): Promise<{ ok: true; values: Record<string, string> } | { ok: false; description: string }> {
  const contentType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return { ok: false, description: "OAuth requests require form encoding." };
  }
  const contentLength = Number(c.req.header("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > OAUTH_BODY_LIMIT_BYTES) {
    return { ok: false, description: "OAuth request is too large." };
  }
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > OAUTH_BODY_LIMIT_BYTES) {
    return { ok: false, description: "OAuth request is too large." };
  }
  const values: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(text)) {
    if (Object.hasOwn(values, name)) {
      return { ok: false, description: `OAuth parameter ${name} must occur exactly once.` };
    }
    values[name] = value;
  }
  return { ok: true, values };
}

export function parseBasicClient(header: string | undefined) {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

export function hasDuplicateQueryParameter(
  requestUrl: string,
  repeatableParameters: ReadonlySet<string> = new Set(),
): boolean {
  const seen = new Set<string>();
  for (const name of new URL(requestUrl).searchParams.keys()) {
    if (seen.has(name) && !repeatableParameters.has(name)) return true;
    seen.add(name);
  }
  return false;
}

export function parseAuthorizationHandle(c: Context<AppEnv>): string {
  const parsed = oauthAuthorizationHandleQuery.safeParse(c.req.query());
  if (!parsed.success) throw new BadRequestError("Missing or invalid authorization request.");
  return parsed.data.request;
}

export function mapAuthorizeError(error: string): string {
  if (error === "invalid-client") return "unauthorized_client";
  if (error === "invalid-scope") return "invalid_scope";
  return "invalid_request";
}

export function authorizationRedirectError(
  c: Context<AppEnv>,
  redirectUri: string,
  state: string | undefined,
  issuer: string,
  error: string,
  description: string,
) {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (state) target.searchParams.set("state", state);
  target.searchParams.set("iss", issuer);
  return c.redirect(target.toString(), 303);
}
