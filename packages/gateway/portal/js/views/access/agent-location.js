// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Where an agent runs decides which of the gateway's addresses it can use, so
// the Connect dialog asks that first:
//
// - `machine`: on the computer the gateway runs on. It uses the plain-HTTP
//   loopback address, which needs no certificate; while that address does not
//   answer, the gateway's HTTPS loopback address, with what stands in the
//   plain one's way.
// - `home`: on another computer on the same network. It uses the gateway's
//   home-network addresses, once the owner lets agents there sign in, and has
//   to trust the certificate the gateway serves there.
// - `away`: anywhere else, including the agents that connect from their
//   vendor's servers. It uses the addresses away from home (the relay, a
//   Tailscale address, the owner's own domain), as `addressChoices` lists them.
//
// Only an address that answers is ever given: a location whose address does
// not answer says why instead.

import { addressChoices, leadsWithLocalAddress, NO_RELAY, NO_TAILSCALE } from "./public-address.js";
import { LOCAL_MCP_KEYS } from "../remote-access/at-home.js";

export const AGENT_LOCATIONS = ["machine", "home", "away"];

/** How each location is offered. */
export const LOCATION_LABELS = {
  machine: { title: "On this computer", text: "Where this gateway runs." },
  home: { title: "At home", text: "Another computer on the same network." },
  away: { title: "Somewhere else", text: "Another network, or a hosted app such as ChatGPT." },
};

/**
 * Where an agent on this computer connects:
 *
 * - `resource`: the address to give it, or null when there is none.
 * - `plain`: it is the plain-HTTP loopback address, which needs no certificate.
 * - `state`: where that plain address stands (`listening`, `starting`, `off`,
 *   `container`, `port-in-use`, `failed`), and `port` the port it uses.
 */
export function machineAddress(oauth) {
  const local = oauth?.thisComputer;
  if (local?.state === "listening" && local.resource)
    return { resource: local.resource, plain: true, state: "listening", port: local.port ?? null };
  const https = local?.gatewayUrl
    ? `${local.gatewayUrl}/mcp`
    : leadsWithLocalAddress(oauth)
      ? oauth.resource
      : null;
  return { resource: https, plain: false, state: local?.state ?? "off", port: local?.port ?? null };
}

/**
 * Why the plain address for agents on this computer is not the one given, as
 * text parts (a string, `{ code }`), or null while it answers.
 */
export function machineProblem(machine) {
  switch (machine.state) {
    case "listening":
      return null;
    case "port-in-use":
      return [
        `The address that needs no certificate couldn't start: port ${machine.port} is in use by another program. Set `,
        { code: LOCAL_MCP_KEYS.port },
        " to a free port in Settings, Config, then restart the gateway. Until then the address below needs a certificate step, and Claude Code can't use it.",
      ];
    case "failed":
      return [
        `The address that needs no certificate couldn't start on port ${machine.port}. The gateway's log says why; `,
        { code: LOCAL_MCP_KEYS.port },
        " in Settings, Config moves it.",
      ];
    case "container":
      return ["This gateway runs in a container, so the address that needs no certificate isn't available here."];
    case "starting":
      return ["The address that needs no certificate is still starting. Reopen this dialog in a moment."];
    default:
      return [
        "The address that needs no certificate is turned off with ",
        { code: LOCAL_MCP_KEYS.enabled },
        " in Settings, Config.",
      ];
  }
}

/**
 * The home network as the dialog offers it: `offered` when the gateway listens
 * beyond this computer, `allowed` once the owner lets agents there sign in, and
 * `entries`, the gateway's addresses there with the certificate each presents,
 * its `.local` name first.
 */
export function homeAddresses(oauth) {
  const home = oauth?.homeNetwork;
  if (!home) return { offered: false, allowed: false, entries: [] };
  return { offered: true, allowed: home.allowed === true, entries: home.resources ?? [] };
}

/**
 * The addresses away from home: every address `addressChoices` lists but the
 * loopback one, a choice between them where `addressChoices` makes one.
 */
export function awayChoices(oauth, relay = NO_RELAY, tailscale = NO_TAILSCALE) {
  const choices = addressChoices(oauth, relay, tailscale);
  const options = choices.options.filter((option) => option.kind !== "machine");
  const initial = options.some((option) => option.resource === choices.initial)
    ? choices.initial
    : (options[0]?.resource ?? null);
  return { ...choices, options, selectable: choices.selectable && options.length > 1, initial };
}

/** Where the dialog opens: away from home when the gateway has an address there, else this computer. */
export function initialLocation(oauth, relay = NO_RELAY, tailscale = NO_TAILSCALE) {
  return awayChoices(oauth, relay, tailscale).options.length > 0 ? "away" : "machine";
}

/**
 * The overview as one location's agents see it: `resource` the address chosen
 * there, `resources` what that address presents. Every agent's setup is written
 * for it (`agentSetups`).
 */
export function locationOauth(oauth, location, resource) {
  if (location === "away") return resource === oauth.resource ? oauth : { ...oauth, resource };
  if (location === "home") {
    const entries = homeAddresses(oauth).entries;
    return { ...oauth, resource, resources: entries };
  }
  const machine = machineAddress(oauth);
  if (machine.plain) return { ...oauth, resource, resources: [] };
  // The plain address presents no certificate at all. The HTTPS one presents the gateway's
  // own, as the overview found it where it checked; otherwise no public authority vouches
  // for a loopback name.
  const known = oauth.resources?.find((entry) => entry.resource === resource);
  return {
    ...oauth,
    resource,
    resources: [known ?? { resource, servedByGateway: true, direct: true, publiclyTrusted: false }],
  };
}

/** The address a managed integration's machine pairs against at one location. */
export function locationHarnessAddress(oauth, location, resource) {
  if (location === "machine") {
    const gatewayUrl = oauth.thisComputer?.gatewayUrl ?? resource?.replace(/\/mcp$/u, "");
    return gatewayUrl?.startsWith("https:") ? { gatewayUrl, servedByGateway: true, direct: true } : null;
  }
  if (location === "home") {
    const entry = homeAddresses(oauth).entries.find((candidate) => candidate.resource === resource);
    return entry
      ? { gatewayUrl: resource.replace(/\/mcp$/u, ""), servedByGateway: entry.servedByGateway, direct: entry.direct }
      : null;
  }
  return null;
}
