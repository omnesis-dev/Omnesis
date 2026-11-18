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

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type TailscaleCliCandidate,
  tailscaleCliCandidates,
  tailscaleCliEnv,
  tailscaleIsRunningStatus,
} from "@omnesis/core";

const execFileAsync = promisify(execFile);
const NOT_RUNNING =
  "Tailscale is installed on this computer but not running or not signed in. Open Tailscale and sign in.";
const NOT_INSTALLED = "Tailscale is not installed on this computer.";
const STATUS_TIMEOUT_MS = 5_000;
const PUBLISH_TIMEOUT_MS = 30_000;

/** The HTTPS ports `tailscale funnel` accepts, in the order publishing tries them. */
const FUNNEL_PORTS = [443, 8443, 10000] as const;

export const NO_FREE_PORT =
  "Tailscale on this computer already serves other apps on 443, 8443 and 10000, the ports it can publish. Free one of them, then check again.";

/**
 * Tailscale already on this computer, as the gateway finds it:
 * - `unsupported`: the gateway runs in a container, whose own network Tailscale on the
 *   host cannot forward to, so the option does not apply here;
 * - `missing`: no Tailscale command on this computer;
 * - `stopped`: Tailscale is installed but not running or not signed in;
 * - `available`: running, with the machine's name on the tailnet.
 */
export type HostTailscale =
  | { state: "unsupported" | "missing" | "stopped"; reason: string }
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

/** A failed change names why, and the command to run instead when there is one. */
export type Refusal = { ok: false; reason: string; command?: string };
export type PublishOutcome = { ok: true; url: string } | Refusal;
export type UnpublishOutcome = { ok: true } | Refusal;

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

/** Why Tailscale refused a change, from what its command printed. */
function refusalReason(error: unknown): string {
  // Tailscale prints the link that enables Funnel on stdout, its refusals on stderr.
  const failed = error as { stdout?: string; stderr?: string };
  const output = `${failed.stdout ?? ""}${failed.stderr ?? ""}${error instanceof Error ? error.message : ""}`;
  if (/access denied|permission|operator|not permitted/i.test(output))
    return "This gateway is not allowed to change Tailscale on this computer. Run the command below as root or as the computer's Tailscale operator.";
  if (
    /funnel.*not (enabled|allowed)|enable funnel|nodeAttrs|https:\/\/login\.tailscale\.com/i.test(
      output,
    )
  )
    return "Your tailnet does not allow Funnel or HTTPS certificates yet. Run the command below once: it prints the link that turns them on.";
  return "Tailscale did not accept the change. Run the command below to see why.";
}

export class HostTailscaleService {
  constructor(
    private readonly port: number,
    private readonly candidates: TailscaleCliCandidate[] = tailscaleCliCandidates(),
    private readonly run: RunCli = liveRun,
    private readonly inContainer: boolean = existsSync("/.dockerenv"),
  ) {}

  async status(): Promise<HostTailscale> {
    if (this.inContainer) {
      return {
        state: "unsupported",
        reason:
          "This gateway runs in a container, where Tailscale on the computer cannot reach it.",
      };
    }
    const found = await this.findRunning();
    if (!found.running) {
      return found.installed
        ? { state: "stopped", reason: NOT_RUNNING }
        : { state: "missing", reason: NOT_INSTALLED };
    }
    const { dnsName } = found.running;
    const served = (await this.served(found.running)) ?? NOTHING_SERVED;
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
    const found = await this.findRunning();
    if (!found.running) {
      return {
        ok: false,
        reason: found.installed ? NOT_RUNNING : NOT_INSTALLED,
        command: commandOn(443),
      };
    }
    const served = await this.served(found.running);
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
      await this.run(found.running.candidate, this.publishArgs(publicly, port), PUBLISH_TIMEOUT_MS);
      return { ok: true, url: addressOn(found.running.dnsName, port) };
    } catch (error) {
      return { ok: false, reason: refusalReason(error), command: commandOn(port) };
    }
  }

  /**
   * Stop forwarding the machine's name to this gateway: every port that serves this
   * gateway alone is turned off, with its Funnel. A port that also serves anything else
   * is another app's and stays as it is.
   */
  async unpublish(): Promise<UnpublishOutcome> {
    const found = await this.findRunning();
    if (!found.running) return { ok: false, reason: found.installed ? NOT_RUNNING : NOT_INSTALLED };
    const served = await this.served(found.running);
    if (!served) {
      return {
        ok: false,
        reason:
          "Omnesis couldn't read what Tailscale on this computer serves, so it changed nothing. Run tailscale serve status to see it.",
      };
    }
    const ports = [...served.gateway.keys()];
    const command = ports.map((port) => `tailscale serve --https=${port} off`).join(" && ");
    try {
      for (const port of ports) {
        await this.run(
          found.running.candidate,
          ["serve", `--https=${port}`, "off"],
          PUBLISH_TIMEOUT_MS,
        );
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: refusalReason(error), command };
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

  /**
   * The first Tailscale command that reports a running, signed-in node, and whether any
   * command exists at all: a command that runs but reports no node (or exits with an
   * error because the daemon is down) still counts as installed; only a missing file does not.
   */
  private async findRunning(): Promise<{
    installed: boolean;
    running: { candidate: TailscaleCliCandidate; dnsName: string } | null;
  }> {
    let installed = false;
    for (const candidate of this.candidates) {
      try {
        const output = await this.run(candidate, ["status", "--json"], STATUS_TIMEOUT_MS);
        installed = true;
        if (!tailscaleIsRunningStatus(output)) continue;
        const dnsName = String(
          (JSON.parse(output) as { Self?: { DNSName?: unknown } }).Self?.DNSName ?? "",
        )
          .replace(/\.$/, "")
          .toLowerCase();
        if (dnsName) return { installed, running: { candidate, dnsName } };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") installed = true;
      }
    }
    return { installed, running: null };
  }
}
