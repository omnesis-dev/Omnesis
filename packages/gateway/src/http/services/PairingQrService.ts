// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isIP } from "node:net";
import {
  assertNever,
  buildPairingPayloadV2,
  buildPairingPayloadV3,
  buildPairingPayloadV4,
  classifyPairingHost,
  isTailnetName,
  judgePairingAddress,
  pairingHost,
  pairingPlatformForKind,
  pairingReachRank,
  swapHost,
  type HostNetwork,
  type NetworkIdentity,
  type PairingAddressOption,
  type PairingAddressContext,
  type PairingAddressPlan,
  type PairingHostClass,
  type PairingPlatform,
} from "@omnesis/core";
import { BadRequestError } from "../errors.js";
import type { DeviceKind } from "@omnesis/types";

export type PairingQrTrustMode =
  "auto" | "system" | "pinned-leaf" | "pinned-leaf-strict" | "pinned-key-strict";

export interface PairingQrServiceOptions {
  /** Relay origins retain their verified key even if another certificate passes WebPKI. */
  strictPinOrigins?: readonly string[];
  /** The served leaf's fingerprint, read at encode time so a rotation applies at once. */
  tlsFingerprint?: string | (() => string);
  /** SHA256 of the currently served leaf's complete DER SubjectPublicKeyInfo. */
  tlsSpkiFingerprint?: string | (() => string);
  /** Public SNI keys can renew independently of the direct gateway identity. */
  strictPinSpkiFingerprint?: () => string | undefined;
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
  /**
   * Names the host is reached by that the gateway cannot discover for itself:
   * the host names and addresses a Docker install hands its gateway in
   * OMNESIS_TLS_EXTRA_NAMES. Only those the served certificate covers belong
   * here, since a phone verifies the certificate against the name it dials.
   */
  hostNames?: () => readonly string[];
  /**
   * Whether the gateway runs inside a container. Behind a Docker bridge it
   * discovers the container's own addresses, which phones cannot reach.
   */
  inContainer?: boolean;
  /**
   * The network of the host this container runs on, as the host's launcher
   * last recorded it (`<config>/host-network`), or null when none is
   * recorded. Read on every request, so a new address from the router is
   * offered as soon as the launcher has seen it. Consulted only in a container.
   */
  hostNetwork?: () => HostNetwork | null;
}

const IDENTITY_LABELS: Record<NetworkIdentity["kind"], string> = {
  lan: "Local network",
  mdns: "Local name",
  "tailscale-magicdns": "Tailscale name",
  tailscale: "Tailscale IP",
};

/** How a host name the gateway was given, but did not discover, is labeled. */
const HOST_NAME_LABELS: Record<PairingHostClass, string> = {
  loopback: "This computer",
  "local-address": IDENTITY_LABELS.lan,
  "local-name": "Host name",
  "tailnet-address": IDENTITY_LABELS.tailscale,
  "tailnet-name": IDENTITY_LABELS["tailscale-magicdns"],
  "public-address": "Public address",
  "public-name": "Public address",
};

/** The container's own addresses: phones never reach the network Docker gives a container. */
const CONTAINER_ADDRESS = {
  label: "Docker container address",
  reason:
    "This is the Docker container's own address, on a network that exists only inside Docker, so a phone can't reach it. Use one of this computer's addresses instead.",
};
const CONTAINER_NAME = {
  label: "Docker container name",
  reason:
    "The gateway announces this name only on the Docker container's own network, so a phone can't find it. Use one of this computer's addresses instead.",
};

/**
 * Where phones reach this gateway, as one request sees it: the host's
 * identities and the port Docker publishes, or for a gateway on the host's
 * own network what it discovers itself.
 */
interface NetworkView {
  /** The host's identities a phone may be offered. */
  identities: NetworkIdentity[];
  /**
   * Whether they are what the host's launcher recorded, rather than what the
   * gateway discovered: then the host's `.local` name among them is the one
   * the host itself answers for, and they come before the installer's names.
   */
  recorded: boolean;
  /** The port a phone reaches those identities and the given host names on. */
  port: string;
  /** The host names the gateway was given that are worth offering. */
  hostNames: string[];
  /** The `.local` name the gateway advertises, when phones can find it. */
  advertisedLocalName: string | null;
  /**
   * Behind a Docker bridge: the container's own addresses and names, which
   * are refused, and the hosts that name the container to another container.
   */
  container: {
    refused: Array<{ host: string; label: string; reason: string }>;
    names: Set<string>;
  } | null;
}

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
    const discovered = await this.options.discoverIdentities();
    const view = this.networkView(discovered, "");
    // Behind a Docker bridge the host's identities stand in for what the
    // container discovers; the host's `.local` name there is its real mDNS one.
    const identities = view.container ? view.identities : discovered;
    const trustedHosts = new Set([
      ...[...this.allowlistedOrigins()].map((origin) => pairingHost(new URL(origin))),
      ...(this.options.publiclyTrustedHosts?.() ?? []).map(normalizeHost),
    ]);
    const isTrusted = (identity: NetworkIdentity) =>
      trustedHosts.has(normalizeHost(identity.address));
    return [...identities.filter(isTrusted), ...identities.filter((i) => !isTrusted(i))];
  }

  /**
   * The host's view of the network for one request. A gateway in a container
   * is behind a Docker bridge when its host's launcher recorded the host's
   * network (`hostNetwork`), or, for an install whose launcher predates that,
   * when it was given host names and discovers none of them. Behind a bridge
   * every address and name the gateway discovers or advertises belongs to the
   * container's own network, so they are refused; the host's recorded
   * identities, at the port Docker publishes, are what phones reach.
   */
  private networkView(discovered: NetworkIdentity[], requestPort: string): NetworkView {
    const listenPort = this.options.listenPort ? String(this.options.listenPort) : requestPort;
    const hostNames = pairableHostNames(this.options.hostNames?.() ?? []);
    const advertisedLocalName = this.options.advertisedLocalName?.() ?? null;
    const inContainer = this.options.inContainer === true;
    const host = inContainer ? (this.options.hostNetwork?.() ?? null) : null;
    const givenHosts = new Set(hostNames);
    const bridged =
      host !== null ||
      (inContainer &&
        hostNames.length > 0 &&
        !discovered.some((i) => i.kind === "lan" && givenHosts.has(normalizeHost(i.address))));
    if (!bridged) {
      return {
        identities: discovered,
        recorded: false,
        port: listenPort,
        hostNames,
        advertisedLocalName,
        container: null,
      };
    }
    const refused = [
      ...discovered
        .filter((i) => i.kind === "lan")
        .map((i) => ({ host: i.address, ...CONTAINER_ADDRESS })),
      ...(advertisedLocalName ? [{ host: advertisedLocalName, ...CONTAINER_NAME }] : []),
    ];
    const names = new Set(
      [
        ...refused.map((r) => r.host),
        ...discovered
          .filter((i) => i.kind === "mdns")
          .flatMap((i) => [i.address, i.address.replace(/\.local$/u, "")]),
      ].map(normalizeHost),
    );
    return {
      identities: host?.identities ?? [],
      recorded: host !== null,
      port: host?.port ? String(host.port) : listenPort,
      // The recorded network is read fresh; an address the installer wrote
      // into the environment may since have changed, so only names stay.
      hostNames: host ? hostNames.filter((h) => !isIP(h)) : hostNames,
      advertisedLocalName: null,
      container: { refused, names },
    };
  }

  /**
   * Every address the phone behind `pairingCode` can be given, judged for that
   * phone and ordered best first. Candidates are each allowlisted origin, the
   * host's network identities at the port phones reach them on (the host's
   * own `.local` name replaced by the one the gateway advertises), the host
   * names the gateway was given (`hostNames`), and the host the caller reached
   * the gateway by, at the port it used. A loopback address is left out: no
   * phone reaches it (a simulator on this host can still be given one
   * explicitly).
   *
   * Behind a Docker bridge (`networkView`) the identities are the host's, its
   * `.local` name included, at the port Docker publishes; the container's own
   * addresses and the `.local` name it advertises on Docker's network are
   * listed as refused, and a caller that reached the gateway from inside
   * Docker does not add the address it used.
   */
  async pairingAddresses(input: {
    pairingCode: string;
    requestHost: string;
    requestPort: string;
  }): Promise<PairingAddressPlan> {
    const platform = this.platformFor(input.pairingCode);
    const context = this.judgeContext(platform);
    const discovered = await this.options.discoverIdentities();
    const view = this.networkView(discovered, input.requestPort);
    const { identities, hostNames, container } = view;
    const labelFor = (host: string, otherwise: string) => {
      const identity = identities.find((i) => normalizeHost(i.address) === normalizeHost(host));
      if (identity) return IDENTITY_LABELS[identity.kind];
      return isTailnetName(host) ? IDENTITY_LABELS["tailscale-magicdns"] : otherwise;
    };

    const candidates = new Map<string, string>();
    for (const origin of this.allowlistedOrigins()) {
      candidates.set(origin, labelFor(new URL(origin).hostname, "Public address"));
    }
    const hostCandidates = (): void => {
      for (const host of hostNames) {
        const url = originAt(host, view.port);
        if (!candidates.has(url)) {
          candidates.set(url, labelFor(host, HOST_NAME_LABELS[classifyPairingHost(host)]));
        }
      }
    };
    // The names the gateway was given come before what it discovers, and
    // after what the host's launcher recorded, which is read fresh.
    if (!view.recorded) hostCandidates();
    for (const identity of identities) {
      if (identity.kind === "mdns" && !view.recorded) continue;
      const url = originAt(identity.address, view.port);
      if (!candidates.has(url)) candidates.set(url, IDENTITY_LABELS[identity.kind]);
    }
    if (view.recorded) hostCandidates();
    if (view.advertisedLocalName) {
      const url = originAt(view.advertisedLocalName, view.port);
      if (!candidates.has(url)) candidates.set(url, IDENTITY_LABELS.mdns);
    }
    // Natively the host's own `.local` name stays out even when the caller
    // reached the gateway by it: a phone may resolve it to an address it
    // cannot reach. Behind a bridge, a caller on Docker's network (another
    // container, or the CLI in this one) used an address only Docker knows.
    const requestedHostIsOwnLocalName =
      container === null &&
      discovered.some(
        (i) => i.kind === "mdns" && normalizeHost(i.address) === normalizeHost(input.requestHost),
      );
    const requestedFromDocker =
      container !== null &&
      (container.names.has(normalizeHost(input.requestHost)) ||
        (this.options.listenPort !== undefined &&
          input.requestPort === String(this.options.listenPort) &&
          input.requestPort !== view.port));
    const requested = originAt(input.requestHost, input.requestPort);
    if (!requestedHostIsOwnLocalName && !requestedFromDocker && !candidates.has(requested)) {
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
    for (const refused of container?.refused ?? []) {
      const gatewayUrl = originAt(refused.host, view.port);
      if (candidates.has(gatewayUrl)) continue;
      judged.push({
        option: {
          gatewayUrl,
          host: pairingHost(new URL(gatewayUrl)),
          label: refused.label,
          usable: false,
          reason: refused.reason,
        },
        rank: Number.POSITIVE_INFINITY,
        index: judged.length,
      });
    }
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
            onTailnet:
              identities.some((i) => i.kind === "tailscale" || i.kind === "tailscale-magicdns") ||
              hostNames.some(
                (host) => isTailnetName(host) || classifyPairingHost(host) === "tailnet-address",
              ),
            tailscaleName:
              identities.find((i) => i.kind === "tailscale-magicdns")?.address ??
              hostNames.find(isTailnetName) ??
              null,
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

    // Relay pairing retains its verified key even when the origin also passes WebPKI.
    const strictPin = this.options.strictPinOrigins?.some(
      (origin) => canonicalOrigin(origin) === canonicalOrigin(input.gatewayUrl),
    );
    if (strictPin && input.trustMode === "system")
      throw new BadRequestError("Relay pairing requires a verified gateway certificate pin");
    const configuredSpki =
      strictPin && this.options.strictPinSpkiFingerprint
        ? this.options.strictPinSpkiFingerprint
        : this.options.tlsSpkiFingerprint;
    const spki = typeof configuredSpki === "function" ? configuredSpki() : configuredSpki;
    if (strictPin && this.options.strictPinSpkiFingerprint && !spki)
      throw new BadRequestError("Public gateway TLS identity is not ready for pairing");
    const trustMode = strictPin
      ? spki
        ? "pinned-key-strict"
        : "pinned-leaf-strict"
      : (input.trustMode ?? "auto");
    switch (trustMode) {
      case "auto":
        return verdict.systemTrust
          ? this.systemTrustPayload(input)
          : this.compatibilityPayload(input);
      case "system":
        if (!verdict.systemTrust) {
          throw new BadRequestError("system TLS trust is not allowed for this gateway origin");
        }
        return this.systemTrustPayload(input);
      case "pinned-key-strict":
        if (!spki || !/^[a-f0-9]{64}$/.test(spki))
          throw new BadRequestError("pinned-key TLS trust requires a gateway SPKI fingerprint");
        return JSON.stringify(
          buildPairingPayloadV4({
            gatewayUrl: canonicalOrigin(input.gatewayUrl),
            pairingCode: input.pairingCode,
            tls: { mode: "pinned-key-strict", spkiFingerprint: spki },
          }),
        );
      case "pinned-leaf":
      case "pinned-leaf-strict": {
        const fingerprint = this.tlsFingerprintSha256;
        if (!fingerprint) {
          throw new BadRequestError("pinned-leaf TLS trust requires a gateway fingerprint");
        }
        return JSON.stringify(
          buildPairingPayloadV4({
            gatewayUrl: canonicalOrigin(input.gatewayUrl),
            pairingCode: input.pairingCode,
            tls: { mode: trustMode, fingerprint },
          }),
        );
      }
      default:
        return assertNever(trustMode);
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

/**
 * The host names worth offering a phone, IPv4 addresses first, as discovery
 * orders its own. The host's own `.local` name stays out, as it does when
 * discovered: a phone may resolve it to a container bridge the host also
 * announces. So do IPv6 addresses, which discovery does not offer either.
 */
function pairableHostNames(hosts: readonly string[]): string[] {
  const names = [...new Set(hosts.map(normalizeHost))].filter(
    (host) => host.length > 0 && !host.endsWith(".local") && isIP(host) !== 6,
  );
  return [...names.filter((host) => isIP(host) === 4), ...names.filter((host) => !isIP(host))];
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
