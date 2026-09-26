// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * URL policy for user-configured HTTP inference backends.
 *
 * Inference requests can carry document chunks, search queries, prompts, OCR
 * images, and backend API keys. The safe default is therefore loopback-only:
 * local vLLM/Ollama/llama-server keeps working, while public cloud APIs and
 * LAN hosts require an explicit privacy opt-in in config.
 */

import dns from "node:dns/promises";
import net from "node:net";
import type { LookupAddress } from "node:dns";

const MAX_REDIRECTS = 5;

export type InferenceAddressClass = "loopback" | "private" | "public" | "blocked";

export interface InferenceUrlPolicy {
  /**
   * When false/omitted, only loopback addresses are allowed. When true, public
   * and RFC1918/private LAN addresses are allowed too. Link-local, metadata,
   * multicast, and unspecified addresses remain blocked.
   */
  allowRemoteInference?: boolean;
  /** Test seam for deterministic DNS checks. Defaults to node:dns.lookup. */
  lookup?: (hostname: string, opts: { all: true }) => Promise<LookupAddress[]>;
}

export interface InferenceFetchPolicy extends InferenceUrlPolicy {
  /** Test seam for HTTP callers that already inject fetch. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export class InferenceUrlPolicyError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: string,
    public readonly code:
      | "remote_inference_disabled"
      | "inference_url_blocked" = "inference_url_blocked",
  ) {
    super(`Inference URL policy refused ${url}: ${reason}`);
    this.name = "InferenceUrlPolicyError";
  }
}

export function classifyInferenceIp(ip: string): InferenceAddressClass {
  const family = net.isIP(ip);
  if (family === 0) return "blocked";
  if (family === 4) return classifyIpv4(ip);
  return classifyIpv6(ip);
}

function classifyIpv4(ip: string): InferenceAddressClass {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return "blocked";
  }
  const [a, b] = parts;
  // 0.0.0.0/8 — "this network" / unspecified.
  if (a === 0) return "blocked";
  // 10.0.0.0/8 — RFC 1918 private.
  if (a === 10) return "private";
  // 100.64.0.0/10 — carrier-grade NAT, often internal/tailnet-adjacent.
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return "private";
  // 127.0.0.0/8 — loopback.
  if (a === 127) return "loopback";
  // 169.254.0.0/16 — link-local + common cloud metadata paths.
  if (a === 169 && b === 254) return "blocked";
  // 172.16.0.0/12 — RFC 1918 private.
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return "private";
  // 192.168.0.0/16 — RFC 1918 private.
  if (a === 192 && b === 168) return "private";
  // 198.18.0.0/15 — benchmarking/private test networks.
  if (a === 198 && (b === 18 || b === 19)) return "private";
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved.
  if (a >= 224) return "blocked";
  return "public";
}

function expandIpv6(ip: string): number[] | null {
  let head = ip;
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(":");
  const afterLastColon = ip.slice(lastColon + 1);
  if (afterLastColon.includes(".")) {
    const octets = afterLastColon.split(".").map((p) => parseInt(p, 10));
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
      return null;
    }
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    head = ip.slice(0, lastColon);
  }

  let groups: number[];
  const doubleIdx = head.indexOf("::");
  if (doubleIdx !== -1) {
    const left = head
      .slice(0, doubleIdx)
      .split(":")
      .filter((s) => s.length > 0);
    const right = head
      .slice(doubleIdx + 2)
      .split(":")
      .filter((s) => s.length > 0);
    const fill = 8 - (left.length + right.length + tail.length);
    if (fill < 0) return null;
    groups = [
      ...left.map((h) => parseInt(h, 16)),
      ...new Array<number>(fill).fill(0),
      ...right.map((h) => parseInt(h, 16)),
      ...tail,
    ];
  } else {
    const hex = head.split(":").filter((s) => s.length > 0);
    groups = [...hex.map((h) => parseInt(h, 16)), ...tail];
  }

  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

function classifyIpv6(ip: string): InferenceAddressClass {
  const lower = ip.toLowerCase();
  const groups = expandIpv6(lower);
  if (!groups) return "blocked";

  const firstSixZero = groups.slice(0, 6).every((g) => g === 0);
  if (firstSixZero && groups[6] === 0) {
    if (groups[7] === 0) return "blocked"; // ::
    if (groups[7] === 1) return "loopback"; // ::1
  }

  const isV4Mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isV4Compat = firstSixZero && !(groups[6] === 0 && (groups[7] === 0 || groups[7] === 1));
  if (isV4Mapped || isV4Compat) {
    const a = groups[6] >> 8;
    const b = groups[6] & 0xff;
    const c = groups[7] >> 8;
    const d = groups[7] & 0xff;
    return classifyIpv4(`${a}.${b}.${c}.${d}`);
  }

  // fc00::/7 unique-local.
  if (groups[0] >= 0xfc00 && groups[0] <= 0xfdff) return "private";
  // fe80::/10 link-local.
  if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) return "blocked";
  // ff00::/8 multicast.
  if (groups[0] >= 0xff00 && groups[0] <= 0xffff) return "blocked";
  return "public";
}

function assertAddressClassAllowed(
  rawUrl: string,
  address: string,
  addressClass: InferenceAddressClass,
  allowRemoteInference: boolean,
): void {
  if (addressClass === "blocked") {
    throw new InferenceUrlPolicyError(rawUrl, `address ${address} is blocked`);
  }
  if (!allowRemoteInference && addressClass !== "loopback") {
    throw new InferenceUrlPolicyError(
      rawUrl,
      `address ${address} is ${addressClass}; set inference.allowRemoteInference=true to use non-loopback HTTP inference`,
      "remote_inference_disabled",
    );
  }
}

export async function assertInferenceUrlAllowed(
  rawUrl: string,
  policy: InferenceUrlPolicy = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InferenceUrlPolicyError(rawUrl, "invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InferenceUrlPolicyError(rawUrl, `disallowed scheme ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new InferenceUrlPolicyError(rawUrl, "embedded credentials are not allowed");
  }

  const hostLiteral = url.hostname.replace(/^\[|\]$/g, "");
  const allowRemoteInference = policy.allowRemoteInference === true;
  if (net.isIP(hostLiteral)) {
    const addressClass = classifyInferenceIp(hostLiteral);
    assertAddressClassAllowed(rawUrl, hostLiteral, addressClass, allowRemoteInference);
    return url;
  }

  const lookup =
    policy.lookup ??
    ((hostname: string, opts: { all: true }) =>
      dns.lookup(hostname, opts) as Promise<LookupAddress[]>);
  let addrs: LookupAddress[];
  try {
    addrs = await lookup(hostLiteral, { all: true });
  } catch (err) {
    throw new InferenceUrlPolicyError(
      rawUrl,
      `DNS resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addrs.length === 0) {
    throw new InferenceUrlPolicyError(rawUrl, "DNS resolution returned no addresses");
  }

  for (const addr of addrs) {
    assertAddressClassAllowed(
      rawUrl,
      addr.address,
      classifyInferenceIp(addr.address),
      allowRemoteInference,
    );
  }
  return url;
}

export async function fetchWithInferenceUrlPolicy(
  rawUrl: string,
  init: RequestInit = {},
  policy: InferenceFetchPolicy = {},
): Promise<Response> {
  const fetchFn = policy.fetchFn ?? fetch;
  let currentUrl = rawUrl;

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const parsed = await assertInferenceUrlAllowed(currentUrl, policy);
    const response = await fetchFn(currentUrl, { ...init, redirect: "manual" });
    if (typeof response.status !== "number" || response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) return response;

    const nextUrl = new URL(location, currentUrl);
    await assertInferenceUrlAllowed(nextUrl.toString(), policy);
    if (nextUrl.origin !== parsed.origin) {
      throw new InferenceUrlPolicyError(
        currentUrl,
        `cross-origin redirect to ${nextUrl.origin} is blocked`,
      );
    }
    currentUrl = nextUrl.toString();
  }

  throw new InferenceUrlPolicyError(rawUrl, `too many redirects (>${MAX_REDIRECTS})`);
}
