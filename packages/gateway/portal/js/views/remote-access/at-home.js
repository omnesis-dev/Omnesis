// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// How agents reach the gateway at home, as Settings → Connectivity, the MCP
// server page and the Connect dialog all say it:
//
// - This computer: the plain-HTTP address on loopback, which needs no
//   certificate. It is configuration (`gateway.localMcp`), not a choice on
//   these pages, so they say where it stands and, when it does not answer, why
//   and how to change it. They never show an address that does not answer.
// - The home network: the gateway's own addresses there, where agents may sign
//   in once the owner allows it. Devices pair there whatever the choice.

import { html } from "htm/preact";

/** The config keys behind the address for agents on this computer. */
export const LOCAL_MCP_KEYS = { port: "gateway.localMcp.port", enabled: "gateway.localMcp.enabled" };

/** What allowing agents on the home network means, said before the owner chooses. */
export const HOME_NETWORK_WARNINGS = [
  "Any device on your network can reach the sign-in page. A connection still needs your approval, here or on your phone.",
  "The agent's computer has to trust this gateway's certificate. The setup for each agent shows how, and says when an agent can't.",
  "An address in numbers can change when your router hands out a new one. The .local name stays the same.",
  "ChatGPT, Claude apps and Grok bot can't use it: they connect from their own servers.",
];

/** The MCP endpoint at an origin. */
const endpointAt = (origin) => (origin ? `${origin.replace(/\/$/u, "")}/mcp` : null);

/**
 * The address for agents on this computer as one line of the summary:
 * `{ mark, detail }`, with `mark` "on", "warn" or "off" and `detail` a list of
 * text parts (a string, or `{ code }`).
 */
export function localMcpLine(localMcp) {
  const port = localMcp?.port;
  switch (localMcp?.state) {
    case "listening":
      return {
        mark: "on",
        detail: ["Connect at ", { code: endpointAt(localMcp.url) }, ", with no certificate step."],
      };
    case "port-in-use":
      return {
        mark: "warn",
        detail: [
          `Couldn't start: port ${port} is in use by another program. Set `,
          { code: LOCAL_MCP_KEYS.port },
          " to a free port in Settings, Config, then restart the gateway.",
        ],
      };
    case "failed":
      return {
        mark: "warn",
        detail: [
          `Couldn't start on port ${port}; the gateway's log says why. `,
          { code: LOCAL_MCP_KEYS.port },
          " in Settings, Config moves it.",
        ],
      };
    case "starting":
      return { mark: "off", detail: ["Starting…"] };
    case "container":
      return {
        mark: "off",
        detail: ["This gateway runs in a container, so agents on this computer use its HTTPS address."],
      };
    default:
      return {
        mark: "off",
        detail: [
          "Turned off with ",
          { code: LOCAL_MCP_KEYS.enabled },
          ". Agents on this computer use the gateway's HTTPS address.",
        ],
      };
  }
}

/** The home network as one line of the summary, from its MCP row: `{ mark, detail }`. */
export function homeNetworkLine(row) {
  if (!row)
    return {
      mark: "off",
      detail: ["This gateway listens on this computer only, so other computers can't reach it."],
    };
  const where = row.url ? [" at ", { code: endpointAt(row.url) }] : [];
  return row.reach === "on"
    ? { mark: "on", detail: ["Can sign in", ...where, ". Your phones and computers still pair here either way."] }
    : {
        mark: "off",
        detail: ["Can't sign in until you allow it. Your phones and computers still pair here either way."],
      };
}

/** Text parts: a string, or `{ code }`. */
export function Parts({ parts }) {
  return parts.map((part) => (typeof part === "string" ? part : html`<code>${part.code}</code>`));
}
