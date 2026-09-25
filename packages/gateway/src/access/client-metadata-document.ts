// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import * as z from "zod/v4";
import type { LookupAddress } from "node:dns";

import type { OAuthClientMetadataDocument } from "./types.js";

const MAX_DOCUMENT_BYTES = 5 * 1_024;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_CACHE_AGE_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 256;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface MetadataResponse {
  status: number;
  contentType: string | undefined;
  cacheControl: string | undefined;
  body: Buffer;
}

export interface ClientMetadataDocumentDependencies {
  now(): number;
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  fetch(url: URL, address: ResolvedAddress): Promise<MetadataResponse>;
}

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
    client_uri: z.string().max(2_048).optional(),
    client_secret: z.unknown().optional(),
    client_secret_expires_at: z.unknown().optional(),
  })
  .passthrough();

const specialIpv4Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  specialIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
const specialIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  specialIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

/** Fetches and briefly caches untrusted client metadata behind an SSRF boundary. */
export class ClientMetadataDocumentResolver {
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: OAuthClientMetadataDocument }
  >();

  constructor(private readonly dependencies: ClientMetadataDocumentDependencies = defaultDeps) {}

  async resolve(clientId: string): Promise<OAuthClientMetadataDocument | null> {
    const url = parseClientIdentifierUrl(clientId);
    if (!url) return null;
    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > this.dependencies.now()) return cached.value;
    this.cache.delete(clientId);

    const addresses = await withTimeout(this.dependencies.resolve(url.hostname), FETCH_TIMEOUT_MS);
    if (
      addresses.length === 0 ||
      addresses.some(
        ({ address, family }) =>
          isIP(address) !== family ||
          (family === 4
            ? specialIpv4Addresses.check(address, "ipv4")
            : specialIpv6Addresses.check(address, "ipv6")),
      )
    ) {
      throw new Error("Client metadata host is not publicly routable.");
    }
    // The transport is pinned to an address from this validated answer. It
    // must not resolve the hostname again, closing the DNS-rebinding window.
    const response = await withTimeout(
      this.dependencies.fetch(url, addresses[0]!),
      FETCH_TIMEOUT_MS,
    );
    if (response.status !== 200) throw new Error("Client metadata returned a non-success status.");
    if (!isJsonContentType(response.contentType)) {
      throw new Error("Client metadata must be served as JSON.");
    }
    if (response.body.byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error("Client metadata exceeds the size limit.");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new Error("Client metadata is not valid JSON.");
    }
    const parsed = metadataSchema.safeParse(raw);
    if (!parsed.success || parsed.data.client_id !== clientId) {
      throw new Error("Client metadata does not match its client identifier.");
    }
    if (
      parsed.data.redirect_uris.some((redirectUri) => !isPermittedRedirectUri(redirectUri)) ||
      (parsed.data.client_uri !== undefined && !isPermittedHttpsUrl(parsed.data.client_uri))
    ) {
      throw new Error("Client metadata contains an invalid URL.");
    }
    const grantTypes = parsed.data.grant_types ?? ["authorization_code", "refresh_token"];
    const responseTypes = parsed.data.response_types ?? ["code"];
    const authMethod = parsed.data.token_endpoint_auth_method ?? "none";
    if (
      authMethod !== "none" ||
      parsed.data.client_secret !== undefined ||
      parsed.data.client_secret_expires_at !== undefined ||
      !grantTypes.includes("authorization_code") ||
      grantTypes.some((value) => value !== "authorization_code" && value !== "refresh_token") ||
      responseTypes.length !== 1 ||
      responseTypes[0] !== "code"
    ) {
      throw new Error("Client metadata requests unsupported OAuth behavior.");
    }
    const value: OAuthClientMetadataDocument = {
      clientId,
      clientName: parsed.data.client_name,
      redirectUris: parsed.data.redirect_uris,
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod: "none",
      clientUri: parsed.data.client_uri ?? null,
    };
    const cacheAge = cacheAgeMs(response.cacheControl);
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

function isJsonContentType(value: string | undefined): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.match(/^application\/.+\+json$/u));
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

function isPermittedHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

function cacheAgeMs(value: string | undefined): number {
  if (!value || /(?:^|,)\s*(?:no-store|no-cache|private)(?:\s|,|$)/iu.test(value)) return 0;
  const match = value.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/iu);
  if (!match) return 0;
  return Math.min(Number(match[1]) * 1_000, MAX_CACHE_AGE_MS);
}

const defaultDeps: ClientMetadataDocumentDependencies = {
  now: Date.now,
  resolve: async (hostname) => {
    const unbracketed = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
    const literalFamily = isIP(unbracketed);
    if (literalFamily !== 0) {
      return [{ address: unbracketed, family: literalFamily as 4 | 6 }];
    }
    return (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
      address,
      family: family as 4 | 6,
    }));
  },
  fetch: fetchPinned,
};

/**
 * A DNS lookup that always answers with the address the caller already vetted,
 * which is what closes the rebinding window between validation and connection.
 *
 * Node calls a custom lookup in two shapes. The `autoSelectFamily` connect path
 * (`lookupAndConnectMultiple`, default-on since Node 20) passes `all: true` and
 * reads an array of answers back; the single-address path reads the positional
 * arguments. Answering only positionally makes the former read `undefined` as
 * the address and throw `ERR_INVALID_IP_ADDRESS`, so serve both shapes.
 */
export function pinnedLookup(resolved: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options.all === true) {
      (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, [
        { address: resolved.address, family: resolved.family },
      ]);
      return;
    }
    callback(null, resolved.address, resolved.family);
  };
}

function fetchPinned(url: URL, resolved: ResolvedAddress): Promise<MetadataResponse> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = <T>(callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    const req = request(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        lookup: pinnedLookup(resolved),
      },
      (response) => {
        const advertisedLength = Number(response.headers["content-length"]);
        if (Number.isFinite(advertisedLength) && advertisedLength > MAX_DOCUMENT_BYTES) {
          req.destroy(new Error("Client metadata exceeds the size limit."));
          return;
        }
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_DOCUMENT_BYTES) {
            req.destroy(new Error("Client metadata exceeds the size limit."));
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", (error) => finish(reject, error));
        response.on("end", () =>
          finish(resolve, {
            status: response.statusCode ?? 0,
            contentType: Array.isArray(response.headers["content-type"])
              ? response.headers["content-type"][0]
              : response.headers["content-type"],
            cacheControl: Array.isArray(response.headers["cache-control"])
              ? response.headers["cache-control"][0]
              : response.headers["cache-control"],
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new Error("Client metadata timed out.")),
      FETCH_TIMEOUT_MS,
    );
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error("Client metadata timed out.")));
    req.once("error", (error) => finish(reject, error));
    req.end();
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Client metadata timed out.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
