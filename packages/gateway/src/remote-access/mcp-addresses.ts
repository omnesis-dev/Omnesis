// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which of the gateway's addresses away from home answer MCP, and how far. The
 * owner turns MCP off on an address, or keeps it to their Tailscale network,
 * and from then on a request reaching the gateway that way finds no MCP
 * endpoint and none of the OAuth routes an MCP client signs in through: they
 * answer 404, as on a gateway without them. The portal, device APIs and
 * everything else on that address are unaffected, except through Funnel on
 * this computer, whose pages and API have their own choice (host-access.ts).
 *
 * The addresses, in the order the owner sees them, with the choices each has:
 *
 * - `relay` (off, public): the Omnesis relay address, recognised by the
 *   request arriving through the relay tunnel, or by its Host, since the
 *   gateway terminates TLS for that name. Until the gateway is connected it
 *   has no address and nothing matches it.
 * - `tailnet` (off, private, public): the gateway's own Tailscale device,
 *   recognised by the request arriving from the tailnet through the helper's
 *   private socket, or by its Host. Public is the device's own `publicAccess`
 *   setting (Tailscale Funnel), which already limits that address to the paths
 *   MCP clients use; this reads and writes that setting and keeps no copy.
 * - `host` (off, private, public): Tailscale already running on this
 *   computer, by the machine's MagicDNS name, which `tailscale serve` and
 *   `tailscale funnel` pass on as the request's Host, on whichever port it
 *   serves the gateway. A request Tailscale forwards from the Internet carries
 *   its Funnel header, so it is this address whatever Host it names. Every
 *   gateway with a listening port has it.
 * - `domain` (off, on): the address in `gateway.publicBaseUrl`, recognised by
 *   Host, which whatever publishes it (a reverse proxy, a tunnel) must pass on.
 *   The gateway cannot tell whether it is private or public. When that address
 *   is one of the ways above — the owner saved the relay's or a Tailscale name
 *   as the public address — it is that way's, under that way's choice, and has
 *   no row of its own.
 *
 * Every address answers MCP until the owner turns it off: only an explicit
 * choice in remote-access.json refuses, so a file written before these
 * choices existed, or none at all, changes nothing. A Host naming a loopback
 * address always answers, so a gateway can never lock its own machine out; a
 * request through the relay or the tailnet is that address whatever Host it
 * names. Tokens are untouched: an address that answers checks a token's
 * resource exactly as before.
 *
 * This computer's Tailscale address is also an OAuth issuer (`hostIssuer`),
 * as the relay's and the device's are, so agents sign in through it without
 * it being the gateway's public address.
 */

import { assertNever, createLogger } from "@omnesis/core";
import { publicPathAllowed } from "../tailscale-embed/caller.js";
import type { CloudRelayManagement } from "@omnesis/cloud-relay";
import type { RemoteAccessSettingsStore } from "./settings.js";
import type { HostAccess, HostMcpReach } from "./host-access.js";
import type { Refusal } from "./host-tailscale.js";
import type { TailscaleEmbedService } from "../tailscale-embed/service.js";

const log = createLogger("gateway:remote-access:mcp");

/** How long this computer's looked-up MagicDNS name is used before Tailscale is asked again. */
const HOST_NAME_TTL_MS = 60_000;

export const MCP_ADDRESS_IDS = ["relay", "tailnet", "host", "domain"] as const;
export type McpAddressId = (typeof MCP_ADDRESS_IDS)[number];

/**
 * Where MCP answers on an address: nowhere; on the owner's Tailscale network
 * only; on the Internet too; or, for an address whose reach the gateway cannot
 * see, wherever the address reaches.
 */
export const MCP_REACHES = ["off", "private", "public", "on"] as const;
export type McpReach = (typeof MCP_REACHES)[number];

/** The choices each address offers, in the order the owner sees them. */
export const MCP_CHOICES: Record<McpAddressId, readonly McpReach[]> = {
  relay: ["off", "public"],
  tailnet: ["off", "private", "public"],
  host: ["off", "private", "public"],
  domain: ["off", "on"],
};

/** One row of the owner's MCP choices: everything the portal needs to show it. */
export interface McpAddressRow {
  id: McpAddressId;
  /** The address's origin, once it is known. */
  url: string | null;
  /** Where MCP answers there now. */
  reach: McpReach;
  choices: readonly McpReach[];
  /** Whether that way in is set up right now: enrolled, connected, served or configured. */
  available: boolean;
  /**
   * The Tailscale device's public address is wanted but not open yet: Tailscale may want
   * the owner to allow it first, which the device's own page shows.
   */
  opening?: true;
}

export type McpAddressPatch = Partial<Record<McpAddressId, McpReach>>;

/** How a request reached the gateway, as far as the tailnet helper says. */
type TailnetArrival = "tailnet" | "public" | null;

/** What the gateway knows about a request that decides which address it reached. */
export interface McpRequest {
  /** The request URL, whose host is the request's Host. */
  url: string;
  path: string;
  via: TailnetArrival;
  /** It came through the cloud relay's tunnel. */
  relayed: boolean;
  /** It carries the header tailscaled sets on what it forwards from the Internet. */
  funnel: boolean;
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
  /** The gateway's own Tailscale device, when this installation has it. */
  tailscale?: Pick<
    TailscaleEmbedService,
    "tailnetOrigin" | "settings" | "updateSettings" | "state"
  >;
  /** Tailscale already on this computer, when the gateway listens on a port it can forward to. */
  host?: Pick<
    HostAccess,
    | "status"
    | "setMcp"
    | "mcpReach"
    | "mcpAnswersTailnet"
    | "mcpAnswersInternet"
    | "apiAnswersInternet"
  >;
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
  /** The gateway's address there, with its port unless 443. */
  url: string | null;
  servesGateway: boolean;
  /** Funnel is on for the gateway's port. */
  funnel: boolean;
  at: number;
}

/** Why a request was refused, for the log line. */
export type McpRefusal = McpAddressId | "host-internet-api";

export class McpAddresses {
  private hostLookup: HostLookup | null = null;
  private hostInFlight: Promise<HostLookup> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: McpAddressesOptions) {
    this.now = options.now ?? Date.now;
    // This computer's name is an issuer, and refused by while MCP is off there: learn it now.
    if (options.host) void this.lookUpHost();
  }

  /** The addresses this gateway offers a choice for, in the order the owner sees them. */
  offered(): McpAddressId[] {
    return MCP_ADDRESS_IDS.filter((id) => {
      switch (id) {
        case "relay":
          return true;
        case "tailnet":
          return !!this.options.tailscale;
        case "host":
          return !!this.options.host;
        case "domain":
          return true;
        default:
          return assertNever(id);
      }
    });
  }

  /** Every offered address with its choice, after asking Tailscale on this computer again. */
  async list(): Promise<McpAddressRow[]> {
    const host = this.options.host ? await this.lookUpHost() : null;
    const relay = await this.relayNow();
    const tailnet = originOf(this.options.tailscale?.tailnetOrigin());
    const domain = this.options.publicBaseUrl()?.replace(/\/+$/u, "") || null;
    const domainIsOwn = !!domain && this.wayNamed(addressHostname(domain)) === null;
    return this.offered().map((id): McpAddressRow => {
      const choices = MCP_CHOICES[id];
      switch (id) {
        case "relay":
          return {
            id,
            url: relay.origin,
            reach: this.answers(id) ? "public" : "off",
            choices,
            available: !!relay.origin && relay.serving,
          };
        case "tailnet": {
          const opening =
            this.publicWanted() && this.options.tailscale!.state().public.state !== "on";
          return {
            id,
            url: tailnet,
            reach: this.tailnetReach(),
            choices,
            available: !!tailnet,
            ...(opening ? { opening: true as const } : {}),
          };
        }
        case "host":
          return {
            id,
            url: host?.url ?? null,
            reach: this.options.host!.mcpReach(host?.funnel ?? false),
            choices,
            available: !!host?.url && host.servesGateway,
          };
        case "domain":
          return {
            id,
            url: domain,
            reach: this.answers(id) ? "on" : "off",
            choices,
            available: domainIsOwn,
          };
        default:
          return assertNever(id);
      }
    });
  }

  /**
   * The way in whose address a public address is — by default the one the
   * gateway serves in `gateway.publicBaseUrl` — when it is not the owner's own
   * domain: the relay's, the Tailscale device's, or this computer's.
   */
  async publicAddressWay(
    url: string | null | undefined = this.options.publicBaseUrl(),
  ): Promise<Exclude<McpAddressId, "domain"> | null> {
    if (this.options.host) await this.lookUpHost();
    return this.wayNamed(addressHostname(url));
  }

  /** Whether applying `patch` would let MCP answer somewhere it does not now. Anything unreadable is not. */
  loosens(patch: unknown): boolean {
    if (typeof patch !== "object" || patch === null) return false;
    return this.offered().some((id) => {
      const wanted = (patch as Record<string, unknown>)[id];
      return typeof wanted === "string" && rank(wanted) > rank(this.wantedReach(id));
    });
  }

  /**
   * Apply the owner's choices; every key must be one `offered()` lists, with one of its
   * choices. Tailscale on this computer may refuse to change Funnel: the choice is kept
   * and the refusal, naming the command, is returned.
   */
  async update(patch: McpAddressPatch): Promise<Refusal | null> {
    for (const [id, reach] of Object.entries(patch) as Array<[McpAddressId, McpReach]>) {
      if (!this.offered().includes(id)) throw new Error(`No such address: ${id}`);
      if (!MCP_CHOICES[id].includes(reach)) throw new Error(`The ${id} address can't be ${reach}`);
    }
    const { tailnet, host, ...own } = patch;
    if (tailnet !== undefined && tailnet !== this.tailnetReach()) {
      const publicAccess = tailnet === "public";
      if (publicAccess !== this.publicWanted())
        await this.options.tailscale!.updateSettings({ publicAccess });
      this.store("tailnet", tailnet !== "off");
      log.info(`MCP on the Tailscale device's address: ${tailnet}`);
    }
    for (const [id, reach] of Object.entries(own) as Array<["relay" | "domain", McpReach]>) {
      if (this.answers(id) === (reach !== "off")) continue;
      this.store(id, reach !== "off");
      log.info(`MCP on the ${id} address turned ${reach === "off" ? "off" : "on"}`);
    }
    if (host === undefined) return null;
    const outcome = await this.options.host!.setMcp(host as HostMcpReach);
    log.info(`MCP on this computer's Tailscale address: ${host}`);
    // This computer's address is refused by its name and is an issuer: learn it again now.
    await this.lookUpHost();
    return outcome.ok ? null : outcome;
  }

  /**
   * Why a request is not served, or null when it may go on: an MCP client's path that
   * reached the gateway by an address whose MCP does not answer it, or a request Tailscale
   * on this computer forwarded from the Internet for what the owner keeps off it.
   */
  async refusal(request: McpRequest): Promise<McpRefusal | null> {
    const host = this.options.host;
    // The Funnel header can only narrow what a request reaches: a request that claims it
    // falsely is still checked against the address it names below.
    if (host && request.funnel && request.via === null && !request.relayed) {
      if (!isMcpClientPath(request.path)) {
        // An agent's sign-in page loads the portal's styles and scripts.
        const signIn = host.mcpAnswersInternet() && publicPathAllowed(request.path);
        return host.apiAnswersInternet() || signIn ? null : "host-internet-api";
      }
      if (!host.mcpAnswersInternet()) return "host";
    }
    if (!isMcpClientPath(request.path)) return null;
    await this.settle();
    return this.addressesOf(request).find((id) => !this.answers(id)) ?? null;
  }

  /**
   * Bring what `refusal`, `answersAt`, `hostReach` and `hostIssuer` match against up to
   * date: the first caller waits for this computer's MagicDNS name, and once it is a
   * minute old it is looked up again in the background.
   */
  async settle(): Promise<void> {
    if (!this.options.host) return;
    if (!this.hostLookup) await this.lookUpHost();
    else if (this.now() - this.hostLookup.at >= HOST_NAME_TTL_MS) void this.lookUpHost();
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

  /**
   * How far MCP at `url` answers when it is this computer's Tailscale address: on the
   * owner's Tailscale network only, or on the Internet too. Null for any other address.
   */
  hostReach(url: string): "private" | "public" | null {
    const host = this.hostLookup;
    if (!this.options.host || !host?.dnsName || addressHostname(url) !== host.dnsName) return null;
    return this.options.host.mcpReach(host.funnel) === "public" ? "public" : "private";
  }

  /**
   * This computer's Tailscale address as an OAuth issuer, while it serves the gateway and
   * MCP answers there. The gateway's public address wins when it is on the same origin.
   */
  hostIssuer(): string[] {
    const host = this.hostLookup;
    const origin = originOf(host?.url);
    if (!origin || !host?.servesGateway || !this.options.host?.mcpAnswersTailnet()) return [];
    return origin === originOf(this.options.publicBaseUrl()) ? [] : [origin];
  }

  /** The relay's live origin and whether it serves this gateway; not serving when unknown. */
  private async relayNow(): Promise<{ origin: string | null; serving: boolean }> {
    if (!this.options.relayState) {
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

  /** Where MCP answers on an address now, as `loosens` compares it. */
  private wantedReach(id: McpAddressId): McpReach {
    switch (id) {
      case "relay":
        return this.answers(id) ? "public" : "off";
      case "tailnet":
        return this.tailnetReach();
      case "host":
        // What answers now: MCP is on the Internet only while Funnel is on.
        return this.options.host!.mcpReach(this.hostLookup?.funnel ?? false);
      case "domain":
        return this.answers(id) ? "on" : "off";
      default:
        return assertNever(id);
    }
  }

  private tailnetReach(): McpReach {
    if (this.publicWanted()) return "public";
    return this.answers("tailnet") ? "private" : "off";
  }

  private answers(id: McpAddressId): boolean {
    if (id === "host") return this.options.host?.mcpAnswersTailnet() ?? true;
    return this.options.settings.get().mcp?.[id] !== false;
  }

  /** Keep a choice: only an address turned off is written, so the default stays implicit. */
  private store(id: "relay" | "tailnet" | "domain", on: boolean): void {
    const choices = { ...this.options.settings.get().mcp };
    if (on) delete choices[id];
    else choices[id] = false;
    this.options.settings.update({ mcp: choices });
  }

  private publicWanted(): boolean {
    return this.options.tailscale?.settings.get().publicAccess ?? false;
  }

  /** Ask Tailscale on this computer for its name; concurrent askers share one look. */
  private lookUpHost(): Promise<HostLookup> {
    const host = this.options.host!;
    this.hostInFlight ??= host
      .status()
      .then(
        (status): Omit<HostLookup, "at"> =>
          status.state === "available"
            ? {
                dnsName: status.dnsName.toLowerCase(),
                url: status.url,
                servesGateway: status.servesGateway,
                funnel: status.funnel,
              }
            : { dnsName: null, url: null, servesGateway: false, funnel: false },
        (error: unknown) => {
          log.warn(
            `Could not ask Tailscale on this computer for its name: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Keep what was last known, so a passing failure neither lets MCP through by this
          // name nor takes the address away from agents signed in through it.
          return {
            dnsName: this.hostLookup?.dnsName ?? null,
            url: this.hostLookup?.url ?? null,
            servesGateway: this.hostLookup?.servesGateway ?? false,
            funnel: this.hostLookup?.funnel ?? false,
          };
        },
      )
      .then((found) => {
        this.hostLookup = { ...found, at: this.now() };
        return this.hostLookup;
      })
      .finally(() => {
        this.hostInFlight = null;
      });
    return this.hostInFlight;
  }

  /**
   * Every address a request matches, by how it arrived and by its host name.
   * A request through the public Tailscale address is that address, whose
   * choice the helper applies before it arrives, so the tailnet name does not
   * make it a tailnet request.
   */
  private addressesOf({ url, via, relayed }: Omit<McpRequest, "path" | "funnel">): McpAddressId[] {
    const matched = new Set<McpAddressId>();
    const tailscale = !!this.options.tailscale;
    if (tailscale && via === "tailnet") matched.add("tailnet");
    if (relayed) matched.add("relay");
    const hostname = addressHostname(url);
    if (hostname && !isLoopbackHostname(hostname)) {
      if (hostname === addressHostname(this.options.relayOrigin?.())) matched.add("relay");
      if (
        tailscale &&
        via !== "public" &&
        hostname === addressHostname(this.options.tailscale?.tailnetOrigin())
      )
        matched.add("tailnet");
      if (this.hostLookup?.dnsName && hostname === this.hostLookup.dnsName) matched.add("host");
      if (
        hostname === addressHostname(this.options.publicBaseUrl()) &&
        this.wayNamed(hostname) === null
      )
        matched.add("domain");
    }
    return [...matched];
  }

  /** The way in, other than the owner's domain, whose address names `hostname`. */
  private wayNamed(hostname: string | null): Exclude<McpAddressId, "domain"> | null {
    if (!hostname) return null;
    if (hostname === addressHostname(this.options.relayOrigin?.())) return "relay";
    if (
      this.options.tailscale &&
      hostname === addressHostname(this.options.tailscale.tailnetOrigin())
    )
      return "tailnet";
    if (this.hostLookup?.dnsName && hostname === this.hostLookup.dnsName) return "host";
    return null;
  }
}

/** How far a choice lets MCP answer, for comparing two of them. */
function rank(reach: string): number {
  switch (reach) {
    case "off":
      return 0;
    case "private":
      return 1;
    case "public":
    case "on":
      return 2;
    default:
      return -1;
  }
}
