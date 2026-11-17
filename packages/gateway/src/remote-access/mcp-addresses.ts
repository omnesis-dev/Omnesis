// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which of the gateway's addresses away from home answer MCP. The owner turns
 * MCP off on an address, and from then on a request reaching the gateway by
 * that address finds no MCP endpoint and none of the OAuth routes an MCP
 * client signs in through: they answer 404, as on a gateway without them.
 * The portal, device APIs and everything else on that address are unaffected.
 *
 * The addresses, in the order the owner sees them:
 *
 * - `relay`: the Omnesis relay address (OMNESIS_CLOUD_RELAY_ENABLED=1),
 *   recognised by the request arriving through the relay tunnel, or by its
 *   Host, since the gateway terminates TLS for that name.
 * - `tailnet`: the gateway's own Tailscale device on the owner's tailnet
 *   (OMNESIS_TAILSCALE_EMBED_ENABLED=1), recognised by the request arriving
 *   from the tailnet through the helper's private socket, or by its Host.
 * - `tailscalePublic`: the same device's public address (Tailscale Funnel).
 *   Its switch is the device's own `publicAccess` setting, which already
 *   limits that address to the paths MCP clients use; this reads and writes
 *   that setting and keeps no choice of its own.
 * - `host`: Tailscale already running on this computer, by the machine's
 *   MagicDNS name, which `tailscale serve` and `tailscale funnel` pass on as
 *   the request's Host. Every gateway with a listening port has it.
 * - `domain`: the address in `gateway.publicBaseUrl`, recognised by Host,
 *   which whatever publishes it (a reverse proxy, a tunnel) must pass on.
 *   When that address is one of the ways above — the owner saved the relay's
 *   or a Tailscale name as the public address — it is that way's, under that
 *   way's switch, and has no row of its own.
 *
 * Every address answers MCP until the owner turns it off: only an explicit
 * `false` in remote-access.json refuses, so a file written before these
 * choices existed, or none at all, changes nothing. A Host naming a loopback
 * address always answers, so a gateway can never lock its own machine out; a
 * request through the relay or the tailnet is that address whatever Host it
 * names. Tokens are untouched: an address that answers checks a token's
 * resource exactly as before.
 */

import { assertNever, cloudRelayEnabled, createLogger, tailscaleEmbedEnabled } from "@omnesis/core";
import type { CloudRelayManagement } from "@omnesis/cloud-relay";
import type { RemoteAccessSettingsStore } from "./settings.js";
import type { HostTailscaleService } from "./host-tailscale.js";
import type { TailscaleEmbedService } from "../tailscale-embed/service.js";

const log = createLogger("gateway:remote-access:mcp");

/** How long this computer's looked-up MagicDNS name is used before Tailscale is asked again. */
const HOST_NAME_TTL_MS = 60_000;

export const MCP_ADDRESS_IDS = ["relay", "tailnet", "tailscalePublic", "host", "domain"] as const;
export type McpAddressId = (typeof MCP_ADDRESS_IDS)[number];
/** An address whose switch the gateway keeps in remote-access.json. */
export type OwnMcpAddressId = Exclude<McpAddressId, "tailscalePublic">;

/** One row of the owner's MCP switches: everything the portal needs to show it. */
export interface McpAddressRow {
  id: McpAddressId;
  /** The address's origin, once it is known. */
  url: string | null;
  /** Whether MCP answers there; for `tailscalePublic`, whether the public address is wanted. */
  enabled: boolean;
  /** Whether that way in is set up right now: enrolled, connected, served or configured. */
  available: boolean;
}

export type McpAddressPatch = Partial<Record<McpAddressId, boolean>>;

/** How a request reached the gateway, as far as the tailnet helper says. */
type TailnetArrival = "tailnet" | "public" | null;

/** What the gateway knows about a request that decides which address it reached. */
interface McpRequest {
  /** The request URL, whose host is the request's Host. */
  url: string;
  path: string;
  via: TailnetArrival;
  /** It came through the cloud relay's tunnel. */
  relayed: boolean;
}

export interface McpAddressesOptions {
  settings: RemoteAccessSettingsStore;
  /** The address in `gateway.publicBaseUrl` the running gateway serves. */
  publicBaseUrl: () => string | undefined;
  /** The Omnesis relay origin requests for this gateway may name, once it has one. */
  relayOrigin?: () => string | undefined;
  /**
   * The relay as it stands now: its public origin, and whether it serves this
   * gateway, which takes the relay turned on and the gateway enrolled with it.
   */
  relayState?: () => Promise<RelayState>;
  /** The gateway's own Tailscale device, when it is wired. */
  tailscale?: Pick<TailscaleEmbedService, "tailnetOrigin" | "settings" | "updateSettings">;
  /** Tailscale already on this computer, when the gateway listens on a port it can forward to. */
  hostTailscale?: Pick<HostTailscaleService, "status">;
  now?: () => number;
}

/**
 * Whether a path belongs to what an MCP client uses: the endpoint itself, the
 * OAuth discovery documents (including an issuer's path-prefixed copies) and
 * the OAuth routes it registers, signs in and gets tokens through. The
 * address a data source's own sign-in returns to (`/oauth/callback`) is not
 * one of them.
 */
export function isMcpClientPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower === "/mcp" || lower.startsWith("/mcp/")) return true;
  if (lower.startsWith("/oauth/")) return lower !== "/oauth/callback";
  return (
    lower.startsWith("/.well-known/oauth-protected-resource") ||
    lower.startsWith("/.well-known/oauth-authorization-server") ||
    lower.endsWith("/.well-known/openid-configuration")
  );
}

/**
 * The host name an address or a Host header names, lowercased and without a
 * port or a trailing dot; IPv6 addresses keep their brackets. Null when it
 * names no host.
 */
export function addressHostname(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    return hostname || null;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/u.test(hostname);
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** What the relay management says about the relay right now. */
export interface RelayState {
  origin: string | undefined;
  serving: boolean;
}

/**
 * The relay's state from its management status: it serves this gateway while
 * it is turned on and the gateway is enrolled, whether its tunnel is up,
 * reconnecting or down at this moment.
 */
export function relayStateFrom(
  management: Pick<CloudRelayManagement, "status">,
): () => Promise<RelayState> {
  return async () => {
    const status = await management.status();
    return {
      origin: status.publicOrigin,
      serving: status.enabled && status.enrollment.state === "enrolled",
    };
  };
}

/** What Tailscale on this computer last said about it. */
interface HostLookup {
  dnsName: string | null;
  servesGateway: boolean;
  at: number;
}

export class McpAddresses {
  private host: HostLookup | null = null;
  private hostInFlight: Promise<HostLookup> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: McpAddressesOptions) {
    this.now = options.now ?? Date.now;
    // A switch already off refuses by this computer's name from the first request on.
    if (options.hostTailscale && !(this.answers("host") && this.answers("domain")))
      void this.lookUpHost();
  }

  /** The addresses this gateway offers a switch for, in the order the owner sees them. */
  offered(): McpAddressId[] {
    const tailscale = tailscaleEmbedEnabled();
    return MCP_ADDRESS_IDS.filter((id) => {
      switch (id) {
        case "relay":
          return cloudRelayEnabled();
        case "tailnet":
          return tailscale;
        case "tailscalePublic":
          return tailscale && !!this.options.tailscale;
        case "host":
          return !!this.options.hostTailscale;
        case "domain":
          return true;
        default:
          return assertNever(id);
      }
    });
  }

  /** Every offered address with its switch, after asking Tailscale on this computer again. */
  async list(): Promise<McpAddressRow[]> {
    const host = this.options.hostTailscale ? await this.lookUpHost() : null;
    const relay = await this.relayNow();
    const tailnet = originOf(this.options.tailscale?.tailnetOrigin());
    const hostUrl = host?.dnsName ? `https://${host.dnsName}` : null;
    const domain = this.options.publicBaseUrl()?.replace(/\/+$/u, "") || null;
    const domainIsOwn = !!domain && this.wayNamed(addressHostname(domain)) === null;
    return this.offered().map((id): McpAddressRow => {
      switch (id) {
        case "relay":
          return {
            id,
            url: relay.origin,
            enabled: this.answers(id),
            available: !!relay.origin && relay.serving,
          };
        case "tailnet":
          return { id, url: tailnet, enabled: this.answers(id), available: !!tailnet };
        case "tailscalePublic":
          return { id, url: tailnet, enabled: this.publicWanted(), available: !!tailnet };
        case "host":
          return {
            id,
            url: hostUrl,
            enabled: this.answers(id),
            available: !!hostUrl && !!host?.servesGateway,
          };
        case "domain":
          return { id, url: domain, enabled: this.answers(id), available: domainIsOwn };
        default:
          return assertNever(id);
      }
    });
  }

  /**
   * The way in whose address a public address is — by default the one the
   * gateway serves in `gateway.publicBaseUrl` — when it is not the owner's own
   * domain: the relay's, either Tailscale name, or this computer's.
   */
  async publicAddressWay(
    url: string | null | undefined = this.options.publicBaseUrl(),
  ): Promise<Exclude<OwnMcpAddressId, "domain"> | null> {
    if (this.options.hostTailscale) await this.lookUpHost();
    return this.wayNamed(addressHostname(url));
  }

  /** Whether applying `patch` would turn MCP on where it is off now. Anything unreadable is not. */
  loosens(patch: unknown): boolean {
    if (typeof patch !== "object" || patch === null) return false;
    return this.offered().some(
      (id) => (patch as Record<string, unknown>)[id] === true && !this.enabled(id),
    );
  }

  /** Apply the owner's choices; every key must be one `offered()` lists. */
  async update(patch: McpAddressPatch): Promise<void> {
    const offered = new Set(this.offered());
    const unknown = Object.keys(patch).filter((key) => !offered.has(key as McpAddressId));
    if (unknown.length > 0) throw new Error(`No such address: ${unknown.join(", ")}`);
    const { tailscalePublic, ...own } = patch;
    if (tailscalePublic !== undefined && tailscalePublic !== this.publicWanted()) {
      await this.options.tailscale!.updateSettings({ publicAccess: tailscalePublic });
      log.info(`MCP on the Tailscale public address turned ${tailscalePublic ? "on" : "off"}`);
    }
    const changed = (Object.entries(own) as Array<[OwnMcpAddressId, boolean | undefined]>).filter(
      (entry): entry is [OwnMcpAddressId, boolean] =>
        entry[1] !== undefined && entry[1] !== this.answers(entry[0]),
    );
    if (changed.length === 0) return;
    const choices = { ...this.options.settings.get().mcp };
    for (const [id, on] of changed) choices[id] = on;
    this.options.settings.update({ mcp: choices });
    for (const [id, on] of changed)
      log.info(`MCP on the ${id} address turned ${on ? "on" : "off"}`);
    // This computer's address is refused by its name, so learn it before answering.
    if (changed.some(([id, on]) => id === "host" && !on)) await this.lookUpHost();
  }

  /**
   * The address whose MCP is off that this request reached the gateway by,
   * when it asks for an MCP client's path; null when it may go on.
   */
  async refusal(request: McpRequest): Promise<OwnMcpAddressId | null> {
    if (!isMcpClientPath(request.path)) return null;
    await this.settle();
    return this.addressesOf(request).find((id) => !this.answers(id)) ?? null;
  }

  /**
   * Bring what `refusal` and `answersAt` match against up to date. While MCP
   * is off on this computer's address, its MagicDNS name must be known: the
   * first caller waits for it, and once it is a minute old it is looked up
   * again in the background.
   */
  async settle(): Promise<void> {
    // The domain's switch also needs it: a public address that is this computer's
    // name is under the host's switch, not the domain's.
    if (!this.options.hostTailscale || (this.answers("host") && this.answers("domain"))) return;
    if (!this.host) await this.lookUpHost();
    else if (this.now() - this.host.at >= HOST_NAME_TTL_MS) void this.lookUpHost();
  }

  /**
   * Whether an agent can use MCP at `url` (a resource or an issuer origin),
   * so discovery lists only addresses that answer. The tailnet name is also
   * the public Tailscale address, so it stays listed while either answers.
   */
  answersAt(url: string): boolean {
    return this.addressesOf({ url, via: null, relayed: false }).every((id) =>
      id === "tailnet" ? this.answers("tailnet") || this.publicWanted() : this.answers(id),
    );
  }

  /** The relay's live origin and whether it serves this gateway; not serving when unknown. */
  private async relayNow(): Promise<{ origin: string | null; serving: boolean }> {
    if (!cloudRelayEnabled() || !this.options.relayState) {
      return { origin: originOf(this.options.relayOrigin?.()), serving: false };
    }
    try {
      const state = await this.options.relayState();
      return { origin: originOf(state.origin), serving: state.serving };
    } catch (error) {
      log.warn(
        `Could not read the relay's state: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { origin: originOf(this.options.relayOrigin?.()), serving: false };
    }
  }

  private enabled(id: McpAddressId): boolean {
    return id === "tailscalePublic" ? this.publicWanted() : this.answers(id);
  }

  private answers(id: OwnMcpAddressId): boolean {
    return this.options.settings.get().mcp?.[id] !== false;
  }

  private publicWanted(): boolean {
    return this.options.tailscale?.settings.get().publicAccess ?? false;
  }

  /** Ask Tailscale on this computer for its name; concurrent askers share one look. */
  private lookUpHost(): Promise<HostLookup> {
    const hostTailscale = this.options.hostTailscale!;
    this.hostInFlight ??= hostTailscale
      .status()
      .then(
        (status) =>
          status.state === "available"
            ? { dnsName: status.dnsName.toLowerCase(), servesGateway: status.servesGateway }
            : { dnsName: null, servesGateway: false },
        (error: unknown) => {
          log.warn(
            `Could not ask Tailscale on this computer for its name: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Keep refusing by the name already known.
          return { dnsName: this.host?.dnsName ?? null, servesGateway: false };
        },
      )
      .then((found) => {
        this.host = { ...found, at: this.now() };
        return this.host;
      })
      .finally(() => {
        this.hostInFlight = null;
      });
    return this.hostInFlight;
  }

  /**
   * Every address a request matches, by how it arrived and by its host name.
   * A request through the public Tailscale address is that address, whose
   * switch the helper applies before it arrives, so the tailnet name does not
   * make it a tailnet request.
   */
  private addressesOf({ url, via, relayed }: Omit<McpRequest, "path">): OwnMcpAddressId[] {
    const matched = new Set<OwnMcpAddressId>();
    const tailscale = tailscaleEmbedEnabled();
    if (tailscale && via === "tailnet") matched.add("tailnet");
    if (cloudRelayEnabled() && relayed) matched.add("relay");
    const hostname = addressHostname(url);
    if (hostname && !isLoopbackHostname(hostname)) {
      if (cloudRelayEnabled() && hostname === addressHostname(this.options.relayOrigin?.()))
        matched.add("relay");
      if (
        tailscale &&
        via !== "public" &&
        hostname === addressHostname(this.options.tailscale?.tailnetOrigin())
      )
        matched.add("tailnet");
      if (this.host?.dnsName && hostname === this.host.dnsName) matched.add("host");
      if (
        hostname === addressHostname(this.options.publicBaseUrl()) &&
        this.wayNamed(hostname) === null
      )
        matched.add("domain");
    }
    return [...matched];
  }

  /** The way in, other than the owner's domain, whose address names `hostname`. */
  private wayNamed(hostname: string | null): Exclude<OwnMcpAddressId, "domain"> | null {
    if (!hostname) return null;
    if (cloudRelayEnabled() && hostname === addressHostname(this.options.relayOrigin?.()))
      return "relay";
    if (
      tailscaleEmbedEnabled() &&
      hostname === addressHostname(this.options.tailscale?.tailnetOrigin())
    )
      return "tailnet";
    if (this.host?.dnsName && hostname === this.host.dnsName) return "host";
    return null;
  }
}
