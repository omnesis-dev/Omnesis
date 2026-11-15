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

export type HostTailscale =
  | { state: "unavailable"; reason: string }
  | {
      state: "available";
      /** The machine's MagicDNS name, without the trailing dot. */
      dnsName: string;
      url: string;
      /** Tailscale already forwards this name to the gateway, for the tailnet. */
      servesGateway: boolean;
      /** ... and for the Internet, through Funnel. */
      publicGateway: boolean;
    };

export type PublishOutcome =
  { ok: true; url: string } | { ok: false; reason: string; command: string };

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
    const { candidate, dnsName } = found;
    let servesGateway = false;
    let publicGateway = false;
    try {
      const serve = JSON.parse(
        await this.run(candidate, ["serve", "status", "--json"], STATUS_TIMEOUT_MS),
      ) as {
        Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>;
        AllowFunnel?: Record<string, boolean>;
      };
      for (const [hostPort, web] of Object.entries(serve.Web ?? {})) {
        if (!hostPort.startsWith(`${dnsName}:`)) continue;
        if (Object.values(web.Handlers ?? {}).some((h) => forwardsToGateway(h.Proxy, this.port))) {
          servesGateway = true;
          if (serve.AllowFunnel?.[hostPort] === true) publicGateway = true;
        }
      }
    } catch {
      // Nothing served yet, or an older Tailscale without serve status: not serving.
    }
    return { state: "available", dnsName, url: `https://${dnsName}`, servesGateway, publicGateway };
  }

  /** Forward the machine's name to this gateway: on the tailnet, or also publicly. */
  async publish(publicly: boolean): Promise<PublishOutcome> {
    const verb = publicly ? "funnel" : "serve";
    const command = `tailscale ${verb} --bg ${gatewayTarget(this.port)}`;
    // Funnel hands every Internet request to the gateway from this computer's loopback
    // address. Until the gateway trusts the proxy's forwarded address, those requests would
    // pass as local ones and skip the per-address limits on sign-in.
    if (publicly && !this.trustProxy()) {
      return {
        ok: false,
        reason:
          "Before a public address, tell the gateway it runs behind a proxy: add OMNESIS_TRUST_PROXY=true to its .env file and restart it.",
        command,
      };
    }
    const found = await this.findRunning();
    if (!found) {
      return { ok: false, reason: "Tailscale is not running on this computer.", command };
    }
    try {
      await this.run(found.candidate, [verb, "--bg", gatewayTarget(this.port)], PUBLISH_TIMEOUT_MS);
      return { ok: true, url: `https://${found.dnsName}` };
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
      return { ok: false, reason, command };
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
