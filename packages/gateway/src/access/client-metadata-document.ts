// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as z from "zod/v4";

import { SUPPORTED_CLIENT_ASSERTION_ALGORITHMS } from "./client-assertion.js";
import {
  defaultPublicFetchDependencies,
  fetchPublicJson,
  isPermittedHttpsUrl,
  type PublicFetchDependencies,
} from "./public-json-fetch.js";
import type { OAuthClientMetadataDocument } from "./types.js";

const MAX_DOCUMENT_BYTES = 5 * 1_024;
const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;
const MAX_CACHE_ENTRIES = 256;

const metadataSchema = z
  .strictObject({
    client_id: z.string().min(1).max(2_048),
    client_name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((value) => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)),
    redirect_uris: z.array(z.string().min(1).max(2_048)).min(1).max(12),
    grant_types: z.array(z.string()).max(8).optional(),
    response_types: z.array(z.string()).max(8).optional(),
    token_endpoint_auth_method: z.string().optional(),
    token_endpoint_auth_signing_alg: z.string().optional(),
    jwks_uri: z.string().max(2_048).optional(),
    client_uri: z.string().max(2_048).optional(),
    client_secret: z.unknown().optional(),
    client_secret_expires_at: z.unknown().optional(),
  })
  .passthrough();

/** Fetches and briefly caches untrusted client metadata behind an SSRF boundary. */
export class ClientMetadataDocumentResolver {
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: OAuthClientMetadataDocument }
  >();

  constructor(
    private readonly dependencies: PublicFetchDependencies = defaultPublicFetchDependencies,
  ) {}

  async resolve(clientId: string): Promise<OAuthClientMetadataDocument | null> {
    const url = parseClientIdentifierUrl(clientId);
    if (!url) return null;
    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > this.dependencies.now()) return cached.value;
    this.cache.delete(clientId);

    const document = await fetchPublicJson(url, this.dependencies, {
      label: "Client metadata",
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    const parsed = metadataSchema.safeParse(document.value);
    if (!parsed.success || parsed.data.client_id !== clientId) {
      throw new Error("Client metadata does not match its client identifier.");
    }
    if (
      parsed.data.redirect_uris.some((redirectUri) => !isPermittedRedirectUri(redirectUri)) ||
      (parsed.data.client_uri !== undefined && !isPermittedHttpsUrl(parsed.data.client_uri)) ||
      (parsed.data.jwks_uri !== undefined && !isPermittedHttpsUrl(parsed.data.jwks_uri))
    ) {
      throw new Error("Client metadata contains an invalid URL.");
    }
    // The document describes the client, not this server: a grant it can use
    // elsewhere is simply never issued here. Only the ones this server offers
    // are kept, and the client must be able to use the code flow.
    const grantTypes = (parsed.data.grant_types ?? [...SUPPORTED_GRANT_TYPES]).filter((value) =>
      (SUPPORTED_GRANT_TYPES as readonly string[]).includes(value),
    );
    const responseTypes = parsed.data.response_types ?? ["code"];
    const authMethod = parsed.data.token_endpoint_auth_method ?? "none";
    const signingAlg = parsed.data.token_endpoint_auth_signing_alg;
    if (
      (authMethod !== "none" && authMethod !== "private_key_jwt") ||
      // A key-authenticated client names where its public keys live; an
      // inline `jwks` would pin keys the client could never rotate.
      (authMethod === "private_key_jwt" && parsed.data.jwks_uri === undefined) ||
      (authMethod === "private_key_jwt" &&
        signingAlg !== undefined &&
        !(SUPPORTED_CLIENT_ASSERTION_ALGORITHMS as readonly string[]).includes(signingAlg)) ||
      parsed.data.client_secret !== undefined ||
      parsed.data.client_secret_expires_at !== undefined ||
      !grantTypes.includes("authorization_code") ||
      responseTypes.length !== 1 ||
      responseTypes[0] !== "code"
    ) {
      throw new Error("Client metadata requests unsupported OAuth behavior.");
    }
    const common = {
      clientId,
      clientName: parsed.data.client_name,
      redirectUris: parsed.data.redirect_uris,
      grantTypes,
      responseTypes,
      clientUri: parsed.data.client_uri ?? null,
    };
    const value: OAuthClientMetadataDocument =
      authMethod === "private_key_jwt"
        ? { ...common, tokenEndpointAuthMethod: "private_key_jwt", jwksUri: parsed.data.jwks_uri! }
        : { ...common, tokenEndpointAuthMethod: "none", jwksUri: null };
    const cacheAge = document.cacheAgeMs;
    if (cacheAge > 0) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(clientId, { expiresAt: this.dependencies.now() + cacheAge, value });
    }
    return value;
  }
}

function parseClientIdentifierUrl(value: string): URL | null {
  if (!/^https:/iu.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Client identifier is not a valid URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.pathname === "" ||
    url.pathname === "/" ||
    value.includes("\\") ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new Error("Client identifier URL is not permitted.");
  }
  const rawPath = value.slice(value.indexOf("/", "https://".length + 1)).split(/[?#]/u, 1)[0]!;
  if (
    rawPath
      .split("/")
      .some(
        (segment) =>
          decodeURIComponentSafely(segment) === "." || decodeURIComponentSafely(segment) === "..",
      )
  ) {
    throw new Error("Client identifier URL contains a dot path component.");
  }
  return url;
}

function decodeURIComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPermittedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    return (
      !url.hash &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback))
    );
  } catch {
    return false;
  }
}
