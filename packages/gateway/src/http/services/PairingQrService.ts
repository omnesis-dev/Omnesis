// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  assertNever,
  buildPairingPayloadV2,
  buildPairingPayloadV3,
  buildPairingPayloadV4,
  isTailnetName,
  judgePairingAddress,
  pairingHost,
  pairingPlatformForKind,
  pairingReachRank,
  swapHost,
  type NetworkIdentity,
  type PairingAddressOption,
  type PairingAddressContext,
  type PairingAddressPlan,
  type PairingPlatform,
} from "@omnesis/core";
import { BadRequestError } from "../errors.js";
import type { DeviceKind } from "@omnesis/types";

export type PairingQrTrustMode = "auto" | "system" | "pinned-leaf";

export interface PairingQrServiceOptions {
  /** The served leaf's fingerprint, read at encode time so a rotation applies at once. */
  tlsFingerprint?: string | (() => string);
  /** Exact HTTPS origins whose certificate phones verify through platform trust. */
  systemTrustOrigins?: readonly string[] | (() => readonly string[]);
  /**
   * Hosts the served certificate covers with a publicly trusted chain. They
   * are trusted at whatever port a phone reaches them on, since a container
   * or proxy may publish the gateway on a port other than the one it listens on.
   */
  publiclyTrustedHosts?: () => readonly string[];
  /**
   * The device kind a pending pairing code was minted for; null when no
   * pending code matches (expired, redeemed, revoked or never issued).
   */
  pairingKind: (pairingCode: string) => DeviceKind | null;
  /** The host's network identities (LAN, `.local`, Tailscale). */
  discoverIdentities: () => Promise<NetworkIdentity[]>;
  /** The port the gateway listens on, where a phone reaches a discovered identity. */
  listenPort?: number;
  /**
   * The `.local` name the gateway itself advertises with only the host's real
   * LAN addresses, or null when it advertises none. It stands in for the
   * host's own `.local` name, whose mDNS answers can include addresses a
   * phone cannot reach (container bridges, link-local IPv6).
   */
  advertisedLocalName?: () => string | null;
  /**
   * When the served certificate will next be replaced, if the gateway renews
   * it itself; a phone that pins it stops connecting then. Null when pinned
   * pairings do not expire this way.
   */
  certificateRenewsAt?: () => Date | null;
}

const IDENTITY_LABELS: Record<NetworkIdentity["kind"], string> = {
  lan: "Local network",
  mdns: "Local name",
  "tailscale-magicdns": "Tailscale name",
  tailscale: "Tailscale IP",
};

/**
 * Chooses and encodes pairing QR payloads. Every address is judged for the
 * phone the pairing code was minted for (`judgePairingAddress`), so what the
 * portal and CLI offer and what this encoder accepts are the same rule: no
 * client can produce a QR code that phone would refuse.
 */
export class PairingQrService {
  constructor(private readonly options: PairingQrServiceOptions) {}

  /** The fingerprint of the leaf served right now: a rotated certificate is what new pairings pin. */
  private get tlsFingerprintSha256(): string | undefined {
    const fingerprint = this.options.tlsFingerprint;
    return typeof fingerprint === "function" ? fingerprint() : fingerprint;
  }

  private allowlistedOrigins(): ReadonlySet<string> {
    const configured = this.options.systemTrustOrigins ?? [];
    const values = typeof configured === "function" ? configured() : configured;
    return new Set(
      values.flatMap((value) => {
        try {
          return [canonicalOrigin(value)];
        } catch {
          // Existing publicBaseUrl values may contain a path. They remain valid
          // for their original purpose but do not authorize system-trust pairing.
          return [];
        }
      }),
    );
  }

  /** Whether phones verify the gateway at an origin through platform trust, read live. */
  private trustCheck(): (origin: string, host: string) => boolean {
    const origins = this.allowlistedOrigins();
    const hosts = new Set((this.options.publiclyTrustedHosts?.() ?? []).map(normalizeHost));
    return (origin, host) => origins.has(origin) || hosts.has(host);
  }

  /**
   * The judging context for one request, read once: the trust allowlist, the
   * trusted Tailscale name and the certificate's renewal date are live gateway
   * state, and each read touches configuration or the served certificate.
   */
  private judgeContext(platform: PairingPlatform | null): PairingAddressContext {
    const renewsAt = this.options.certificateRenewsAt?.() ?? null;
    return {
      platform,
      isSystemTrusted: this.trustCheck(),
      trustedTailnetName: this.trustedTailnetName(),
      pinnedUntil: renewsAt
        ? renewsAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
        : null,
    };
  }

  /** A Tailscale name phones verify through platform trust, when there is one. */
  private trustedTailnetName(): string | null {
    const hosts = [
      ...(this.options.publiclyTrustedHosts?.() ?? []).map(normalizeHost),
      ...[...this.allowlistedOrigins()].map((origin) => pairingHost(new URL(origin))),
    ];
    return hosts.find(isTailnetName) ?? null;
  }

  /** The host's network identities, those backed by platform trust first. */
  async networkIdentities(): Promise<NetworkIdentity[]> {
    const identities = await this.options.discoverIdentities();
    const trustedHosts = new Set([
      ...[...this.allowlistedOrigins()].map((origin) => pairingHost(new URL(origin))),
      ...(this.options.publiclyTrustedHosts?.() ?? []).map(normalizeHost),
    ]);
    const isTrusted = (identity: NetworkIdentity) =>
      trustedHosts.has(normalizeHost(identity.address));
    return [...identities.filter(isTrusted), ...identities.filter((i) => !isTrusted(i))];
  }

  /**
   * Every address the phone behind `pairingCode` can be given, judged for that
   * phone and ordered best first. Candidates are each allowlisted origin, the
   * host's network identities at the listen port (its own `.local` name
   * replaced by the one the gateway advertises), and the host the caller
   * reached the gateway by, at the port it used. A loopback address is left
   * out: no phone reaches it (a simulator on this host can still be given one
   * explicitly).
   */
  async pairingAddresses(input: {
    pairingCode: string;
    requestHost: string;
    requestPort: string;
  }): Promise<PairingAddressPlan> {
    const platform = this.platformFor(input.pairingCode);
    const context = this.judgeContext(platform);
    const identities = await this.options.discoverIdentities();
    const labelFor = (host: string, otherwise: string) => {
      const identity = identities.find((i) => normalizeHost(i.address) === normalizeHost(host));
      if (identity) return IDENTITY_LABELS[identity.kind];
      return isTailnetName(host) ? IDENTITY_LABELS["tailscale-magicdns"] : otherwise;
    };

    const candidates = new Map<string, string>();
    for (const origin of this.allowlistedOrigins()) {
      candidates.set(origin, labelFor(new URL(origin).hostname, "Public address"));
    }
    const listenPort = this.options.listenPort
      ? String(this.options.listenPort)
      : input.requestPort;
    for (const identity of identities) {
      if (identity.kind === "mdns") continue;
      const url = originAt(identity.address, listenPort);
      if (!candidates.has(url)) candidates.set(url, IDENTITY_LABELS[identity.kind]);
    }
    const localName = this.options.advertisedLocalName?.() ?? null;
    if (localName) {
      const url = originAt(localName, listenPort);
      if (!candidates.has(url)) candidates.set(url, IDENTITY_LABELS.mdns);
    }
    // The host's own `.local` name stays out even when the caller reached the
    // gateway by it: a phone may resolve it to an address it cannot reach.
    const requestedHostIsOwnLocalName = identities.some(
      (i) => i.kind === "mdns" && normalizeHost(i.address) === normalizeHost(input.requestHost),
    );
    const requested = originAt(input.requestHost, input.requestPort);
    if (!requestedHostIsOwnLocalName && !candidates.has(requested)) {
      candidates.set(requested, labelFor(input.requestHost, "The address you're using now"));
    }

    const judged = [...candidates].flatMap(([gatewayUrl, label], index) => {
      const verdict = judgePairingAddress(gatewayUrl, context);
      if (verdict.usable && verdict.reach === "this-computer") return [];
      const option: PairingAddressOption = {
        gatewayUrl,
        host: pairingHost(new URL(gatewayUrl)),
        label,
        ...verdict,
      };
      return [{ option, rank: pairingReachRank(verdict), index }];
    });
    judged.sort((a, b) => a.rank - b.rank || a.index - b.index);
    const addresses = judged.map((j) => j.option);
    const reachesBeyondHome = addresses.some(
      (a) => a.usable && (a.reach === "tailnet" || a.reach === "anywhere"),
    );
    return {
      platform,
      addresses,
      recommendedUrl: addresses.find((a) => a.usable)?.gatewayUrl ?? null,
      awayFromHome: reachesBeyondHome
        ? null
        : {
            onTailnet: identities.some(
              (i) => i.kind === "tailscale" || i.kind === "tailscale-magicdns",
            ),
            tailscaleName: identities.find((i) => i.kind === "tailscale-magicdns")?.address ?? null,
          },
    };
  }

  encode(input: {
    pairingCode: string;
    gatewayUrl: string;
    trustMode?: PairingQrTrustMode;
  }): string {
    const verdict = judgePairingAddress(
      input.gatewayUrl,
      this.judgeContext(this.platformFor(input.pairingCode)),
    );
    if (!verdict.usable) throw new BadRequestError(verdict.reason);

    switch (input.trustMode) {
      case "auto":
        return verdict.systemTrust
          ? this.systemTrustPayload(input)
          : this.compatibilityPayload(input);
      case "system":
        if (!verdict.systemTrust) {
          throw new BadRequestError("system TLS trust is not allowed for this gateway origin");
        }
        return this.systemTrustPayload(input);
      case "pinned-leaf": {
        const fingerprint = this.tlsFingerprintSha256;
        if (!fingerprint) {
          throw new BadRequestError("pinned-leaf TLS trust requires a gateway fingerprint");
        }
        return JSON.stringify(
          buildPairingPayloadV4({
            gatewayUrl: canonicalOrigin(input.gatewayUrl),
            pairingCode: input.pairingCode,
            tls: { mode: "pinned-leaf", fingerprint },
          }),
        );
      }
      case undefined:
        return this.compatibilityPayload(input);
      default:
        return assertNever(input.trustMode);
    }
  }

  private systemTrustPayload(input: { pairingCode: string; gatewayUrl: string }): string {
    return JSON.stringify(
      buildPairingPayloadV4({
        gatewayUrl: canonicalOrigin(input.gatewayUrl),
        pairingCode: input.pairingCode,
        tls: { mode: "system" },
      }),
    );
  }

  /** V3 pinned to the served leaf, or V2 when the gateway has no fingerprint. */
  private compatibilityPayload(input: { pairingCode: string; gatewayUrl: string }): string {
    const fingerprint = this.tlsFingerprintSha256;
    return fingerprint
      ? JSON.stringify(
          buildPairingPayloadV3({
            gatewayUrl: input.gatewayUrl,
            pairingCode: input.pairingCode,
            fingerprint,
          }),
        )
      : JSON.stringify(
          buildPairingPayloadV2({
            gatewayUrl: input.gatewayUrl,
            pairingCode: input.pairingCode,
          }),
        );
  }

  /** The phone a pending code was minted for; refuses a code that is not pending. */
  private platformFor(pairingCode: string): PairingPlatform | null {
    const kind = this.options.pairingKind(pairingCode);
    if (kind === null) {
      throw new BadRequestError(
        "This pairing code has expired or was already used. Create a new one.",
      );
    }
    return pairingPlatformForKind(kind);
  }
}

/** A host as written in an identity, origin or URL, compared the way `pairingHost` does. */
function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[|\]$/gu, "");
}

function originAt(host: string, port: string): string {
  return canonicalOrigin(swapHost(port ? `https://localhost:${port}` : "https://localhost", host));
}

function canonicalOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestError("gatewayUrl must be an absolute HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new BadRequestError("gatewayUrl must be an absolute HTTPS origin");
  }
  return url.origin;
}
