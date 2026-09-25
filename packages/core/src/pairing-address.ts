// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isIP } from "node:net";
import { assertNever } from "./utils.js";
import type { DeviceKind } from "@omnesis/types";

/**
 * Which gateway addresses a phone can pair with, and how far each one reaches.
 *
 * A phone keeps the address it paired with, so the address decides where the
 * phone works afterwards. The platforms differ in what they accept:
 *
 * - iOS applies App Transport Security (ATS) to every connection. A gateway
 *   certificate that the phone's system trust rejects (the gateway's own
 *   self-signed one) is refused on any host ATS does not exempt, even after
 *   the app has matched the pinned fingerprint. ATS exempts local-network
 *   addresses and `.local` names. Since iOS 17, ATS also applies to IP
 *   addresses outside the local ranges, including the carrier-grade NAT range
 *   Tailscale assigns from. So an iPhone reaches anything beyond the local
 *   network only through a name covered by a publicly trusted certificate.
 * - Android has no equivalent policy: a pinned fingerprint is accepted at
 *   any address the phone can reach.
 *
 * Every client that offers a pairing address (portal, CLI) and the gateway's
 * QR encoder read this one classifier, so what is offered and what is
 * refused cannot drift apart.
 */

/** The phone platforms whose pairing QR codes this classifier judges. */
export type PairingPlatform = "ios" | "android";

/**
 * Where a phone paired with an address can reach the gateway.
 * `this-computer` means only a simulator on the gateway's own host;
 * `local-network` means the network the gateway is on (typically home Wi-Fi);
 * `tailnet` means anywhere, while Tailscale is connected on the phone;
 * `anywhere` means wherever the phone can resolve and reach the host.
 */
export type PairingAddressReach = "this-computer" | "local-network" | "tailnet" | "anywhere";

export type PairingAddressVerdict =
  | {
      usable: true;
      reach: PairingAddressReach;
      /** The gateway encodes this address with platform (system) trust. */
      systemTrust: boolean;
      /** One plain sentence on where a phone paired with this address works. */
      summary: string;
    }
  | {
      usable: false;
      /** One plain sentence on why this phone cannot use the address. */
      reason: string;
    };

/** One address a phone could pair with, judged for that phone. */
export type PairingAddressOption = {
  gatewayUrl: string;
  host: string;
  /** Plain-language name of the address, e.g. "Tailscale name". */
  label: string;
} & PairingAddressVerdict;

/**
 * What the operator can do when no offered address reaches beyond the local
 * network. `onTailnet` says whether the gateway host is on a tailnet at all;
 * `tailscaleName` is its Tailscale (MagicDNS) name, null when the tailnet has
 * none for it.
 */
export interface AwayFromHomeHint {
  onTailnet: boolean;
  tailscaleName: string | null;
}

/** The gateway's answer to `POST /admin/devices/pair-addresses`. */
export interface PairingAddressPlan {
  platform: PairingPlatform | null;
  /** Usable addresses best first, then the refused ones. */
  addresses: PairingAddressOption[];
  recommendedUrl: string | null;
  awayFromHome: AwayFromHomeHint | null;
}

export interface PairingAddressContext {
  /** The phone being paired; null judges an address for any client. */
  platform: PairingPlatform | null;
  /**
   * Whether the gateway serves this origin with a certificate the phone's
   * platform trusts. Consulted only for hosts a public CA can certify.
   */
  isSystemTrusted: (origin: string, host: string) => boolean;
  /**
   * The gateway's Tailscale name when it is served with a publicly trusted
   * certificate, so a refused Tailscale IP can point at it; null otherwise.
   */
  trustedTailnetName?: string | null;
  /**
   * The day (already formatted for display) a pinned pairing stops working
   * because the gateway replaces its certificate, or null when pinned
   * pairings do not expire that way.
   */
  pinnedUntil?: string | null;
}

/** What kind of host a URL names, as far as reachability and ATS care. */
type HostClass =
  | "loopback"
  | "local-address"
  | "local-name"
  | "tailnet-address"
  | "tailnet-name"
  | "public-address"
  | "public-name";

/** Judge one candidate gateway URL for the phone described by `context`. */
export function judgePairingAddress(
  gatewayUrl: string,
  context: PairingAddressContext,
): PairingAddressVerdict {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    return { usable: false, reason: "This is not a valid gateway address." };
  }
  if (url.protocol !== "https:") {
    return { usable: false, reason: "Phones pair only with a gateway address that uses HTTPS." };
  }
  const host = pairingHost(url);
  const hostClass = classifyHost(host);
  const trusted = publiclyCertifiable(hostClass) && context.isSystemTrusted(url.origin, host);
  const pinnedUntil = trusted ? null : (context.pinnedUntil ?? null);
  const usable = (reach: PairingAddressReach, changingAddress = false): PairingAddressVerdict => {
    const repairs = [
      ...(changingAddress ? ["if the router gives the gateway a new address"] : []),
      ...(pinnedUntil && reach !== "this-computer"
        ? [`around ${pinnedUntil}, when the gateway renews its certificate`]
        : []),
    ];
    return {
      usable: true,
      reach,
      systemTrust: trusted,
      summary:
        repairs.length > 0
          ? `${summaryFor(reach, host)} Pair again ${repairs.join(", and ")}.`
          : summaryFor(reach, host),
    };
  };

  switch (hostClass) {
    case "loopback":
      return usable("this-computer");
    case "local-address":
      return usable("local-network", true);
    case "local-name":
      return usable("local-network");
    case "tailnet-address":
      if (context.platform === "ios") {
        return {
          usable: false,
          reason: context.trustedTailnetName
            ? `iPhones can't use the gateway's Tailscale IP address: its certificate covers the name ${context.trustedTailnetName}, which works at home and away while Tailscale is connected on the phone.`
            : "iPhones refuse the gateway's own certificate at a Tailscale IP address. Give the gateway a Tailscale certificate and use its Tailscale name instead.",
        };
      }
      return usable("tailnet");
    case "tailnet-name":
      if (context.platform === "ios" && !trusted) {
        return {
          usable: false,
          reason:
            "iPhones accept this Tailscale name only once the gateway has a Tailscale certificate for it.",
        };
      }
      return usable("tailnet");
    case "public-address":
    case "public-name":
      if (context.platform === "ios" && !trusted) {
        return {
          usable: false,
          reason: `iPhones accept ${host} only if the gateway's certificate for it is trusted by Apple devices.`,
        };
      }
      return usable("anywhere");
    default:
      return assertNever(hostClass);
  }
}

/**
 * Hosts a public certificate authority can certify. Private, link-local,
 * Tailscale and loopback addresses and `.local` names never carry a publicly
 * trusted certificate, so a trust allowlist entry for one is not honored.
 */
function publiclyCertifiable(hostClass: HostClass): boolean {
  return (
    hostClass === "tailnet-name" || hostClass === "public-name" || hostClass === "public-address"
  );
}

function summaryFor(reach: PairingAddressReach, host: string): string {
  switch (reach) {
    case "this-computer":
      return "Works only for a simulator running on the gateway computer itself.";
    case "local-network":
      return "Works only while the phone is on the same network as the gateway, such as your home Wi-Fi.";
    case "tailnet":
      return "Works at home and away, as long as Tailscale is connected on the phone.";
    case "anywhere":
      return `Works wherever the phone can reach ${host}.`;
    default:
      return assertNever(reach);
  }
}

/**
 * Order usable addresses best first: reach beyond the local network, then the
 * local network, then this computer; within each, platform trust first.
 * Refused addresses sort last.
 */
export function pairingReachRank(verdict: PairingAddressVerdict): number {
  if (!verdict.usable) return Number.POSITIVE_INFINITY;
  const reach = { anywhere: 0, tailnet: 0, "local-network": 2, "this-computer": 4 }[verdict.reach];
  return reach + (verdict.systemTrust ? 0 : 1);
}

/** The phone platform a device kind pairs as, or null for any other kind. */
export function pairingPlatformForKind(kind: DeviceKind): PairingPlatform | null {
  return kind === "ios" || kind === "android" ? kind : null;
}

/** A URL's host as pairing compares it: lowercase, no brackets, no trailing dot. */
export function pairingHost(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Whether a host is a Tailscale (MagicDNS) name. */
export function isTailnetName(host: string): boolean {
  return host.toLowerCase().replace(/\.$/u, "").endsWith(".ts.net");
}

function classifyHost(host: string): HostClass {
  const family = isIP(host);
  if (family === 4) return classifyIpv4(host);
  if (family === 6) return classifyIpv6(host);
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  // A single-label name resolves only through local search domains or mDNS.
  if (host.endsWith(".local") || !host.includes(".")) return "local-name";
  if (isTailnetName(host)) return "tailnet-name";
  return "public-name";
}

function classifyIpv4(host: string): HostClass {
  const [a = 0, b = 0] = host.split(".").map(Number);
  if (a === 127) return "loopback";
  // RFC 1918 private ranges and 169.254/16 link-local.
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "local-address";
  }
  if (a === 169 && b === 254) return "local-address";
  // RFC 6598 shared address space, which Tailscale assigns from.
  if (a === 100 && b >= 64 && b <= 127) return "tailnet-address";
  return "public-address";
}

function classifyIpv6(host: string): HostClass {
  if (host === "::1") return "loopback";
  if (/^fe[89ab]/u.test(host)) return "local-address";
  // Tailscale's IPv6 prefix.
  if (host.startsWith("fd7a:115c:a1e0:")) return "tailnet-address";
  return "public-address";
}
