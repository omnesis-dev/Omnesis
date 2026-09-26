// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { LookupAddress } from "node:dns";

/**
 * Fetching a small JSON document named by an untrusted party — a client's
 * metadata document or its JSON Web Key Set — from behind an SSRF boundary:
 * every DNS answer must be publicly routable, the connection is pinned to a
 * vetted address, redirects are not followed, and the body is size-capped.
 */

export const PUBLIC_FETCH_TIMEOUT_MS = 3_000;
export const MAX_PUBLIC_CACHE_AGE_MS = 5 * 60_000;

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

export interface PublicFetchDependencies {
  now(): number;
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  fetch(url: URL, address: ResolvedAddress, maxBytes: number): Promise<MetadataResponse>;
}

export interface PublicJsonDocument {
  value: unknown;
  /** How long the publisher allows the document to be reused, capped at five minutes. */
  cacheAgeMs: number;
}

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

/**
 * Fetch and parse one JSON document. `label` names the document in every
 * error message ("Client metadata", "Client JWKS"), which is what the route
 * logs when it refuses the client.
 */
export async function fetchPublicJson(
  url: URL,
  dependencies: PublicFetchDependencies,
  options: { label: string; maxBytes: number },
): Promise<PublicJsonDocument> {
  const { label, maxBytes } = options;
  const addresses = await withTimeout(
    dependencies.resolve(url.hostname),
    PUBLIC_FETCH_TIMEOUT_MS,
    label,
  );
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
    throw new Error(`${label} host is not publicly routable.`);
  }
  // The transport is pinned to an address from this validated answer. It
  // must not resolve the hostname again, closing the DNS-rebinding window.
  const response = await withTimeout(
    dependencies.fetch(url, addresses[0]!, maxBytes),
    PUBLIC_FETCH_TIMEOUT_MS,
    label,
  );
  if (response.status !== 200) throw new Error(`${label} returned a non-success status.`);
  if (!isJsonContentType(response.contentType)) {
    throw new Error(`${label} must be served as JSON.`);
  }
  if (response.body.byteLength > maxBytes) {
    throw new Error(`${label} exceeds the size limit.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  return { value, cacheAgeMs: cacheAgeMs(response.cacheControl) };
}

/** An HTTPS URL without credentials or a fragment. */
export function isPermittedHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isJsonContentType(value: string | undefined): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.match(/^application\/.+\+json$/u));
}

function cacheAgeMs(value: string | undefined): number {
  if (!value || /(?:^|,)\s*(?:no-store|no-cache|private)(?:\s|,|$)/iu.test(value)) return 0;
  const match = value.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/iu);
  if (!match) return 0;
  return Math.min(Number(match[1]) * 1_000, MAX_PUBLIC_CACHE_AGE_MS);
}

export const defaultPublicFetchDependencies: PublicFetchDependencies = {
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

function fetchPinned(
  url: URL,
  resolved: ResolvedAddress,
  maxBytes: number,
): Promise<MetadataResponse> {
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
        if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
          req.destroy(new Error("Response exceeds the size limit."));
          return;
        }
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxBytes) {
            req.destroy(new Error("Response exceeds the size limit."));
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
      () => req.destroy(new Error("Request timed out.")),
      PUBLIC_FETCH_TIMEOUT_MS,
    );
    req.setTimeout(PUBLIC_FETCH_TIMEOUT_MS, () => req.destroy(new Error("Request timed out.")));
    req.once("error", (error) => finish(reject, error));
    req.end();
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
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
