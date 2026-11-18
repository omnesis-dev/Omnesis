// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What Tailscale on this computer lets the Internet reach. Tailscale Funnel
 * publishes a whole port, so the gateway decides what a request through it may
 * use: tailscaled marks every request it forwards from the Internet with
 * `Tailscale-Funnel-Request: ?1` and strips that header from everything else it
 * forwards. The owner chooses two things separately:
 *
 * - `hostApi`: whether the gateway's own pages and device API answer the
 *   Internet, so phones and computers without Tailscale can connect;
 * - `mcp.host`: whether MCP answers nowhere, on the Tailscale network only, or
 *   on the Internet too.
 *
 * Funnel is on while either is wanted on the Internet. A choice the owner never
 * made follows the address: it answers the Internet while Funnel is on, which is
 * what a gateway did before these choices existed, so an owner who turned on
 * Funnel themselves keeps everything as it was.
 *
 * A changed choice is kept even when Tailscale refuses the command that applies
 * it: the refusal names the command, and once the owner runs it the gateway
 * already answers as they chose.
 */

import { createLogger } from "@omnesis/core";
import type {
  HostTailscale,
  HostTailscaleService,
  PublishOutcome,
  Refusal,
  UnpublishOutcome,
} from "./host-tailscale.js";
import type { RemoteAccessSettingsStore } from "./settings.js";

const log = createLogger("gateway:remote-access:host");

/** Where MCP answers on this computer's Tailscale address. */
export type HostMcpReach = "off" | "private" | "public";

/** Tailscale on this computer as the owner sees it: what the Internet reaches through Funnel. */
export type HostAccessStatus =
  | Exclude<HostTailscale, { state: "available" }>
  | (Extract<HostTailscale, { state: "available" }> & {
      /** Funnel is on for the gateway's port. */
      funnel: boolean;
      /** The gateway's pages and device API answer the Internet. */
      publicGateway: boolean;
      /** MCP answers the Internet. */
      publicMcp: boolean;
    });

/** The request header tailscaled sets on what it forwards from the Internet. */
export const FUNNEL_REQUEST_HEADER = "tailscale-funnel-request";

export class HostAccess {
  constructor(
    private readonly host: Pick<HostTailscaleService, "status" | "publish" | "unpublish">,
    private readonly settings: RemoteAccessSettingsStore,
  ) {}

  /** Whether the gateway's pages and device API answer a request through Funnel. */
  apiAnswersInternet(): boolean {
    return this.settings.get().hostApi !== "private";
  }

  /** Whether MCP answers a request through Funnel. */
  mcpAnswersInternet(): boolean {
    const choice = this.settings.get().mcp?.host;
    return choice !== false && choice !== "private";
  }

  /** Whether MCP answers a request from the owner's Tailscale network. */
  mcpAnswersTailnet(): boolean {
    return this.settings.get().mcp?.host !== false;
  }

  /** Where MCP answers right now, given whether Funnel is on. */
  mcpReach(funnel: boolean): HostMcpReach {
    if (!this.mcpAnswersTailnet()) return "off";
    return funnel && this.mcpAnswersInternet() ? "public" : "private";
  }

  async status(): Promise<HostAccessStatus> {
    const found = await this.host.status();
    if (found.state !== "available") return found;
    const funnel = found.publicGateway;
    return {
      ...found,
      funnel,
      publicGateway: funnel && this.apiAnswersInternet(),
      publicMcp: funnel && this.mcpAnswersInternet(),
    };
  }

  /**
   * Serve the gateway, with its pages and device API on the Internet or not. MCP the owner
   * left unset follows them; MCP they put on the Internet keeps Funnel on either way.
   */
  async publish(api: boolean): Promise<PublishOutcome> {
    this.settings.update({ hostApi: api ? "public" : "private" });
    const outcome = await this.host.publish(api || this.settings.get().mcp?.host === true);
    if (outcome.ok) log.info(`Tailscale on this computer serves the gateway at ${outcome.url}`);
    return outcome;
  }

  /** Stop serving the gateway. The owner's choices stay for when it is served again. */
  unpublish(): Promise<UnpublishOutcome> {
    return this.host.unpublish();
  }

  /**
   * Where MCP answers on this computer's address, turning Funnel on or off to match while
   * Tailscale serves the gateway. The pages and device API keep answering as they did:
   * a choice about them the owner never made is fixed to what it is now first.
   */
  async setMcp(reach: HostMcpReach): Promise<{ ok: true } | Refusal> {
    const now = await this.host.status();
    const mcp = {
      ...this.settings.get().mcp,
      host: reach === "off" ? false : reach === "private" ? ("private" as const) : true,
    };
    if (now.state !== "available" || !now.servesGateway) {
      this.settings.update({ mcp });
      return { ok: true };
    }
    const funnel = now.publicGateway;
    const api = funnel && this.apiAnswersInternet();
    this.settings.update({
      mcp,
      ...(this.settings.get().hostApi === undefined
        ? { hostApi: api ? ("public" as const) : ("private" as const) }
        : {}),
    });
    const wanted = api || reach === "public";
    if (wanted === funnel) return { ok: true };
    const outcome = await this.host.publish(wanted);
    if (!outcome.ok) return outcome;
    log.info(`Tailscale Funnel turned ${wanted ? "on" : "off"} for MCP on this computer's address`);
    return { ok: true };
  }
}
