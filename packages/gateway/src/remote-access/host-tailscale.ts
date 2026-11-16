// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tailscale that is already running on the gateway's own computer, as the
 * owner set it up themselves: whether it is there, the machine's name on the
 * tailnet, and whether it already serves this gateway. Publishing runs the
 * same command the docs give (`tailscale serve` for the tailnet, `tailscale
 * funnel` for a public address) so the owner does not have to. Where the
 * gateway lacks the rights to change Tailscale (on Linux that takes root or
 * the machine's Tailscale operator), the result names the exact command to run.
 *
 * `tailscale serve --bg` replaces whatever the machine already serves on that
 * port without a word, so publishing never uses a port another app holds. It
 * picks the first of the ports Funnel accepts (443, 8443, 10000) that is free
 * or already serves this gateway, so a tailnet-only address can later become
 * public on the same port; with all three in use it runs nothing and says so.
 *
 * Only the `tailscale` CLI is used, never its socket. A gateway in a container
 * finds no host Tailscale and says so.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type TailscaleCliCandidate,
  tailscaleCliCandidates,
  tailscaleCliEnv,
  tailscaleIsRunningStatus,
} from "@omnesis/core";
import { reverseProxyTrusted } from "../http/client-ip.js";

const execFileAsync = promisify(execFile);
const STATUS_TIMEOUT_MS = 5_000;
const PUBLISH_TIMEOUT_MS = 30_000;

/** The HTTPS ports `tailscale funnel` accepts, in the order publishing tries them. */
const FUNNEL_PORTS = [443, 8443, 10000] as const;

export const NO_FREE_PORT =
  "Tailscale on this computer already serves other apps on 443, 8443 and 10000, the ports it can publish. Free one of them, then check again.";

export type HostTailscale =
  | { state: "unavailable"; reason: string }
  | {
      state: "available";
      /** The machine's MagicDNS name, without the trailing dot. */
      dnsName: string;
      /**
       * The port the gateway is served on, or the one publishing would use; null when
       * other apps hold every port Funnel accepts and the gateway is not served yet.
       */
      port: number | null;
      /** The gateway's address on that port: `https://<dnsName>`, with `:<port>` unless 443. */
      url: string;
      /** Tailscale already forwards this name to the gateway, for the tailnet. */
      servesGateway: boolean;
      /** ... and for the Internet, through Funnel. */
      publicGateway: boolean;
      /** Why publishing cannot run, when `port` is null. */
      blocked?: string;
    };

/** A failed publish names why, and the command to run instead when there is one. */
export type PublishOutcome =
  { ok: true; url: string } | { ok: false; reason: string; command?: string };

export type RunCli = (
  candidate: TailscaleCliCandidate,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

const liveRun: RunCli = async (candidate, args, timeoutMs) =>
  (
    await execFileAsync(candidate.file, args, {
      timeout: timeoutMs,
      env: tailscaleCliEnv(candidate),
    })
  ).stdout;

/** The address the gateway listens on, as Tailscale should forward to it. */
export function gatewayTarget(port: number): string {
  return `https+insecure://localhost:${port}`;
}

/** Whether a `tailscale serve status --json` handler forwards to this gateway's port. */
function forwardsToGateway(proxy: unknown, port: number): boolean {
  if (typeof proxy !== "string") return false;
  try {
    const url = new URL(proxy.replace(/^https\+insecure:/, "https:"));
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.port === String(port);
  } catch {
    return false;
  }
}

/** The machine's address on a port, as a browser would write it. */
function addressOn(dnsName: string, port: number): string {
  return port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`;
}

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: unknown; HTTP?: unknown; [other: string]: unknown }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>;
  AllowFunnel?: Record<string, boolean>;
  /** Configs of `tailscale serve` runs still in the foreground, by session. */
  Foreground?: Record<string, ServeConfig>;
}

/** What the machine serves, port by port, as it concerns this gateway. */
interface ServedPorts {
  /** Ports that forward their root to this gateway and nothing else, with whether Funnel is on. */
  gateway: Map<number, boolean>;
  /** Ports where something other than this gateway is served. */
  others: Set<number>;
}

function servedPorts(config: ServeConfig, dnsName: string, gatewayPort: number): ServedPorts {
  const gateway = new Map<number, boolean>();
  const others = new Set<number>();
  const visit = (serve: ServeConfig, foreground: boolean) => {
    for (const [port, entry] of Object.entries(serve.TCP ?? {})) {
      // A raw TCP forward or TLS terminator owns the whole port; an HTTPS or HTTP entry
      // only says web handlers live there, judged below.
      if (Object.keys(entry ?? {}).some((key) => key !== "HTTPS" && key !== "HTTP")) {
        others.add(Number(port));
      }
    }
    for (const [hostPort, web] of Object.entries(serve.Web ?? {})) {
      if (!hostPort.startsWith(`${dnsName}:`)) continue;
      const port = Number(hostPort.slice(dnsName.length + 1));
      const handlers = Object.entries(web.Handlers ?? {});
      const onlyGateway =
        handlers.length > 0 &&
        handlers.every(([path, h]) => path === "/" && forwardsToGateway(h.Proxy, gatewayPort));
      // A foreground serve ends with its terminal, so it never counts as this gateway's
      // address, but it still holds the port while it runs.
      if (onlyGateway && !foreground) {
        gateway.set(port, gateway.get(port) === true || serve.AllowFunnel?.[hostPort] === true);
      } else if (handlers.length > 0) {
        others.add(port);
      }
    }
  };
  visit(config, false);
  for (const session of Object.values(config.Foreground ?? {})) visit(session, true);
  for (const port of others) gateway.delete(port);
  return { gateway, others };
}

const NOTHING_SERVED: ServedPorts = { gateway: new Map(), others: new Set() };

const isFunnelPort = (port: number) => (FUNNEL_PORTS as readonly number[]).includes(port);

/**
 * The port to publish on: one that already serves the gateway (a public one first, then
 * one Funnel accepts; going public needs one Funnel accepts), else the first Funnel port
 * nothing else holds, else null.
 */
function choosePort(served: ServedPorts, publicly: boolean): number | null {
  const serving = [...served.gateway]
    .filter(([port]) => !publicly || isFunnelPort(port))
    .sort(
      ([a, aPublic], [b, bPublic]) =>
        Number(bPublic) - Number(aPublic) || Number(isFunnelPort(b)) - Number(isFunnelPort(a)),
    );
  return serving[0]?.[0] ?? FUNNEL_PORTS.find((port) => !served.others.has(port)) ?? null;
}

export class HostTailscaleService {
  constructor(
    private readonly port: number,
    private readonly candidates: TailscaleCliCandidate[] = tailscaleCliCandidates(),
    private readonly run: RunCli = liveRun,
    private readonly trustProxy: () => boolean = reverseProxyTrusted,
  ) {}

  async status(): Promise<HostTailscale> {
    const found = await this.findRunning();
    if (!found) {
      return { state: "unavailable", reason: "Tailscale is not running on this computer." };
    }
    const { dnsName } = found;
    const served = (await this.served(found)) ?? NOTHING_SERVED;
    const port = choosePort(served, false);
    const servesGateway = port !== null && served.gateway.has(port);
    return {
      state: "available",
      dnsName,
      port,
      url: addressOn(dnsName, port ?? 443),
      servesGateway,
      publicGateway: servesGateway && served.gateway.get(port) === true,
      ...(port === null ? { blocked: NO_FREE_PORT } : {}),
    };
  }

  /**
   * Forward the machine's name to this gateway, on the tailnet or also publicly, on the
   * port {@link choosePort} picks; never on a port another app holds.
   */
  async publish(publicly: boolean): Promise<PublishOutcome> {
    const verb = publicly ? "funnel" : "serve";
    const commandOn = (port: number) =>
      `tailscale ${verb} ${this.publishArgs(publicly, port).slice(1).join(" ")}`;
    // Funnel hands every Internet request to the gateway from this computer's loopback
    // address. Until the gateway trusts the proxy's forwarded address, those requests would
    // pass as local ones and skip the per-address limits on sign-in.
    if (publicly && !this.trustProxy()) {
      return {
        ok: false,
        reason:
          "Before a public address, tell the gateway it runs behind a proxy: add OMNESIS_TRUST_PROXY=true to its .env file and restart it.",
        command: commandOn(443),
      };
    }
    const found = await this.findRunning();
    if (!found) {
      return {
        ok: false,
        reason: "Tailscale is not running on this computer.",
        command: commandOn(443),
      };
    }
    const served = await this.served(found);
    // Without knowing what the machine serves, any port could be another app's.
    if (!served) {
      return {
        ok: false,
        reason:
          "Omnesis couldn't read what Tailscale on this computer already serves, so it changed nothing. Run tailscale serve status: if something else uses port 443, add --https=8443 or --https=10000 to the command below.",
        command: commandOn(443),
      };
    }
    const port = choosePort(served, publicly);
    if (port === null) return { ok: false, reason: NO_FREE_PORT };
    try {
      await this.run(found.candidate, this.publishArgs(publicly, port), PUBLISH_TIMEOUT_MS);
      return { ok: true, url: addressOn(found.dnsName, port) };
    } catch (error) {
      // Tailscale prints the link that enables Funnel on stdout, its refusals on stderr.
      const failed = error as { stdout?: string; stderr?: string };
      const output = `${failed.stdout ?? ""}${failed.stderr ?? ""}${error instanceof Error ? error.message : ""}`;
      const reason = /access denied|permission|operator|not permitted/i.test(output)
        ? "This gateway is not allowed to change Tailscale on this computer. Run the command below as root or as the computer's Tailscale operator."
        : /funnel.*not (enabled|allowed)|enable funnel|nodeAttrs|https:\/\/login\.tailscale\.com/i.test(
              output,
            )
          ? "Your tailnet does not allow Funnel or HTTPS certificates yet. Run the command below once: it prints the link that turns them on."
          : "Tailscale did not accept the change. Run the command below to see why.";
      return { ok: false, reason, command: commandOn(port) };
    }
  }

  /** `serve` or `funnel` in the background on `port`, naming it unless it is the default 443. */
  private publishArgs(publicly: boolean, port: number): string[] {
    return [
      publicly ? "funnel" : "serve",
      "--bg",
      ...(port === 443 ? [] : [`--https=${port}`]),
      gatewayTarget(this.port),
    ];
  }

  /** What the machine serves now, or null when Tailscale would not say. */
  private async served(found: {
    candidate: TailscaleCliCandidate;
    dnsName: string;
  }): Promise<ServedPorts | null> {
    try {
      const config = JSON.parse(
        await this.run(found.candidate, ["serve", "status", "--json"], STATUS_TIMEOUT_MS),
      ) as ServeConfig | null;
      return servedPorts(config ?? {}, found.dnsName, this.port);
    } catch {
      return null;
    }
  }

  private async findRunning(): Promise<{
    candidate: TailscaleCliCandidate;
    dnsName: string;
  } | null> {
    for (const candidate of this.candidates) {
      try {
        const output = await this.run(candidate, ["status", "--json"], STATUS_TIMEOUT_MS);
        if (!tailscaleIsRunningStatus(output)) continue;
        const dnsName = String(
          (JSON.parse(output) as { Self?: { DNSName?: unknown } }).Self?.DNSName ?? "",
        )
          .replace(/\.$/, "")
          .toLowerCase();
        if (dnsName) return { candidate, dnsName };
      } catch {
        // Not installed here, or not answering: try the next one.
      }
    }
    return null;
  }
}
