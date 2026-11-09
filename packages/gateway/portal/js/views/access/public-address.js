// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The addresses the connect dialog can give an agent, and what the page says
// about the one that is selected. An agent that connects from its vendor's
// servers needs an address the Internet can reach: one the owner published
// themselves or, with the optional cloud relay, the Omnesis address the
// gateway's account gives it.
//
// Every agent's notice comes from `hostedClientAddress` or
// `localClientAddress`, so the same situation reads the same for each of them.
// Without the relay (`state: "none"`) there is one address, nothing to pick,
// and the wording is the one the page had before the relay existed.
//
// Text is a list of parts: a string, `{ strong }`, `{ href, text }` for a docs
// link, or `{ route, text }` for a link inside the portal.

import { useEffect, useState } from "preact/hooks";

import { relayManagement } from "../../lib/cloud-relay-api.js";

/** The gateway does not serve the docs; these are the published pages. */
export const DOCS = "https://omnesis.dev/docs";
export const PUBLISH_FUNNEL = `${DOCS}/connect#tailscale-funnel`;
export const PUBLISH_DOMAIN = `${DOCS}/setup#public-domain`;

/** Where remote access is turned on, and where a gateway connects to an Omnesis account. */
export const ACCOUNT_SETTINGS_ROUTE = "/portal/settings/account";
const ACCOUNT_SETTINGS = { route: ACCOUNT_SETTINGS_ROUTE, text: "Settings, Account" };

const PRIVATE_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa", ".localhost"];

/**
 * Whether an address can only be reached from the gateway's own networks:
 * loopback, link-local, RFC 1918, carrier-grade NAT (which is where Tailscale
 * addresses live), IPv6 unique-local, and the reserved private DNS suffixes.
 * A public-looking name may still be unpublished; that the gateway cannot see.
 */
export function isPrivateAddress(resource) {
  let host;
  try {
    host = new URL(resource).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    return v6 === "::1" || /^f[cd]/u.test(v6) || /^fe[89ab]/u.test(v6);
  }
  return false;
}

/** Whether an https address names a port other than 443. */
export function usesNonStandardPort(resource) {
  try {
    return new URL(resource).port !== "";
  } catch {
    return false;
  }
}

function isLoopbackAddress(resource) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(resource).hostname);
  } catch {
    return false;
  }
}

function httpsAddress(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? `${url.origin}${url.pathname}`
      : null;
  } catch {
    return null;
  }
}

function sameAddress(left, right) {
  const [a, b] = [httpsAddress(left), httpsAddress(right)];
  return a !== null && a === b;
}

/**
 * Whether the address the dialog leads with only works on the gateway's own
 * machine. The gateway marks every overview without a configured public URL,
 * including one whose address is the relay's, so the address itself decides.
 */
export function leadsWithLocalAddress(oauth) {
  return Boolean(oauth?.loopbackOnly) && isLoopbackAddress(oauth.resource);
}

export const NO_RELAY = Object.freeze({ state: "none" });

/**
 * The gateway's relay-hosted public address, from `GET /admin/cloud-relay`:
 *
 * - `none`: the feature is off, its status is unknown, or this installation
 *   cannot connect to an account. Nothing about the relay is shown.
 * - `not-connected`: the feature is on and the gateway has no public address yet.
 * - `ready`: `url` answers from the Internet.
 * - `checking`: connected, and the gateway is still confirming `url` answers.
 * - `off`: the gateway keeps `url`, with remote access turned off.
 * - `disconnected`: remote access is on and the relay connection is down.
 * - `unreachable`: connected, and `url` did not answer the gateway's check.
 *
 * An address the gateway does not list among the resources it authorizes is
 * never offered: a sign-in against it would be refused.
 *
 * @param {boolean} cloudRelay whether the gateway advertises the feature
 * @param {object | null} status the relay management status, when it was read
 * @param {{ resource: string, resources?: Array<{ resource: string }> } | null} oauth
 */
export function relayPublicAddress(cloudRelay, status, oauth) {
  if (!cloudRelay || !status) return NO_RELAY;
  const url = httpsAddress(status.publicMcp?.url);
  if (!url) return status.serviceConfigured === true ? { state: "not-connected" } : NO_RELAY;
  const authorized = oauth?.resources?.length ? oauth.resources : [{ resource: oauth?.resource }];
  if (!authorized.some((entry) => sameAddress(entry.resource, url))) return NO_RELAY;
  if (!status.enabled) return { state: "off", url };
  if (status.publicMcp.ready === true) return { state: "ready", url };
  if (status.publicMcp.lastError) return { state: "unreachable", url };
  return { state: status.tunnel?.state === "online" ? "checking" : "disconnected", url };
}

/**
 * What is wrong with an Omnesis address that cannot be used right now, how its
 * choice is marked, and what to do about it.
 */
const RELAY_UNAVAILABLE = {
  off: {
    marker: "turned off",
    headline: "Remote access is turned off.",
    action: ["Turn it on in ", ACCOUNT_SETTINGS, "."],
  },
  checking: {
    marker: "being checked",
    headline: "This gateway's Omnesis address is still being checked.",
    action: ["This takes up to a minute. Follow it in ", ACCOUNT_SETTINGS, "."],
  },
  disconnected: {
    marker: "not connected",
    headline: "Remote access is not connected right now.",
    action: ["Check it in ", ACCOUNT_SETTINGS, "."],
  },
  unreachable: {
    marker: "not reachable",
    headline: "This gateway's Omnesis address could not be reached.",
    action: ["Check remote access in ", ACCOUNT_SETTINGS, "."],
  },
};

const PUBLISH_IT_YOURSELF = [
  { href: PUBLISH_FUNNEL, text: "Publish the gateway with Tailscale Funnel" },
  " or ",
  { href: PUBLISH_DOMAIN, text: "use a domain of your own" },
  ".",
];

const CONNECT_AN_ACCOUNT = [
  "Or connect this gateway to an Omnesis account in ",
  ACCOUNT_SETTINGS,
  " to give it a public address.",
];

const PICK_ANOTHER = ["Pick another address from the list above."];
const OR_PICK_ANOTHER = ["Or pick another address from the list above."];

/**
 * One address the gateway authorizes, as the dialog's list names it:
 *
 * - `relay`: the Omnesis address, with `problem` when it cannot be used now.
 * - `public`: an address the owner published themselves.
 * - `network` and `machine`: reachable only from the gateway's networks, or
 *   only on its own machine.
 */
function describeAddress(resource, relay) {
  if (relay.url !== undefined && sameAddress(resource, relay.url)) {
    const problem = RELAY_UNAVAILABLE[relay.state];
    return {
      resource,
      kind: "relay",
      // The state leads, so a closed list that cuts a long address short still shows it.
      text: `Omnesis address (${problem ? problem.marker : "remote access"}): ${resource}`,
      ...(problem ? { problem } : {}),
    };
  }
  if (isLoopbackAddress(resource)) {
    return { resource, kind: "machine", text: `This machine only: ${resource}` };
  }
  return isPrivateAddress(resource)
    ? { resource, kind: "network", text: `This network only: ${resource}` }
    : { resource, kind: "public", text: `Your public address: ${resource}` };
}

/**
 * The addresses the dialog can give an agent: every MCP resource the gateway
 * authorizes, the one it leads with first.
 *
 * - `selectable` says the person picks between them. That takes more than one
 *   address and the relay: without it the dialog shows the one address it
 *   always showed.
 * - `initial` is the address selected until they pick: one the owner
 *   published themselves, since that is their explicit choice and the agents
 *   they already connected use it; else a ready Omnesis address; else the one
 *   the gateway leads with.
 *
 * @param {{ resource: string, resources?: Array<{ resource: string }> }} oauth
 * @param {{ state: string, url?: string }} [relay] from `relayPublicAddress`
 */
export function addressChoices(oauth, relay = NO_RELAY) {
  const resources = [...new Set([oauth.resource, ...(oauth.resources ?? []).map((entry) => entry.resource)])];
  const options = resources.map((resource) => describeAddress(resource, relay));
  const selectable = relay.state !== "none" && options.length > 1;
  const preferred = selectable
    ? (options.find((option) => option.kind === "public") ??
      options.find((option) => option.kind === "relay" && !option.problem))
    : undefined;
  return { options, selectable, initial: preferred?.resource ?? oauth.resource };
}

/** Whether an agent that dials in from the Internet can use an address right now. */
function hostedClientCanUse(agent, option) {
  if (agent.standardPortOnly && usesNonStandardPort(option.resource)) return false;
  return option.kind === "public" || (option.kind === "relay" && !option.problem);
}

/** What an address means for an agent that dials in from the Internet. */
function ownAddress(agent, resource) {
  if (isPrivateAddress(resource)) {
    return {
      reachable: false,
      text: [
        { strong: "This address is private." },
        ` ${agent.needsPublicAddress}, so it cannot reach this gateway until you publish it.`,
      ],
    };
  }
  if (agent.standardPortOnly && usesNonStandardPort(resource)) {
    return {
      reachable: false,
      text: [
        { strong: `This address uses port ${new URL(resource).port}.` },
        ` ${agent.standardPortOnly}, so it cannot reach this gateway there.`,
      ],
    };
  }
  return {
    reachable: true,
    text: [
      `${agent.needsPublicAddress}, so the address above must be reachable from the Internet${agent.standardPortOnly ? " on port 443" : ""}.`,
    ],
  };
}

/**
 * Whether an agent that connects from its vendor's servers can use the
 * selected address, and the notice shown with it.
 *
 * - `usable` is false when the agent cannot connect with this address now.
 * - `notice.paragraphs` is the text, and `notice.warning` marks it as a problem.
 *
 * An Omnesis address that cannot be used right now is explained and points
 * at the account settings. An address the agent cannot reach points at
 * another one in the list when one would work, then at an Omnesis address
 * that only needs turning on, and only without either at publishing the
 * gateway.
 *
 * @param {{ needsPublicAddress: string, standardPortOnly?: string }} agent
 * @param {string} resource the selected address
 * @param {{ state: string, url?: string }} [relay] from `relayPublicAddress`
 * @param {{ options: Array<object>, selectable: boolean }} [choices] from `addressChoices`
 */
export function hostedClientAddress(agent, resource, relay = NO_RELAY, choices = { options: [], selectable: false }) {
  const selected = describeAddress(resource, relay);
  const others = choices.selectable
    ? choices.options.filter((option) => !sameAddress(option.resource, resource))
    : [];
  const another = others.some((option) => hostedClientCanUse(agent, option));
  if (selected.problem) {
    return {
      usable: false,
      notice: {
        warning: true,
        paragraphs: [
          [
            { strong: selected.problem.headline },
            ` ${agent.needsPublicAddress}, so it cannot reach this address right now.`,
          ],
          selected.problem.action,
          ...(another ? [OR_PICK_ANOTHER] : []),
        ],
      },
    };
  }
  const own = ownAddress(agent, resource);
  if (selected.kind === "relay" && own.reachable) {
    return {
      usable: true,
      notice: {
        warning: false,
        paragraphs: [[`${agent.needsPublicAddress}, and this address is reachable from the Internet.`]],
      },
    };
  }
  const waiting = others.find((option) => option.problem)?.problem;
  const publish = [PUBLISH_IT_YOURSELF, ...(relay.state === "not-connected" ? [CONNECT_AN_ACCOUNT] : [])];
  if (own.reachable) {
    // With an Omnesis address in the list, nothing more needs publishing.
    return {
      usable: true,
      notice: { warning: false, paragraphs: [own.text, ...(relay.url === undefined ? publish : [])] },
    };
  }
  return {
    usable: false,
    notice: {
      warning: true,
      paragraphs: [
        own.text,
        ...(another
          ? [PICK_ANOTHER]
          : waiting
            ? [[`This gateway has an Omnesis address. ${waiting.headline} `, ...waiting.action]]
            : publish),
      ],
    },
  };
}

/**
 * The notice for an agent on the owner's own network, which every address
 * suits except an Omnesis address that cannot be used right now. Null when
 * there is nothing to say.
 */
export function localClientAddress(resource, relay = NO_RELAY, choices = { options: [], selectable: false }) {
  const { problem } = describeAddress(resource, relay);
  if (!problem) return null;
  return {
    usable: false,
    notice: {
      warning: true,
      paragraphs: [
        [{ strong: problem.headline }, " This address does not answer right now."],
        problem.action,
        ...(choices.selectable ? [OR_PICK_ANOTHER] : []),
      ],
    },
  };
}

/**
 * What a page that leads with a localhost address says about hosted agents, or
 * null when the relay changes nothing and the page keeps its own sentence.
 */
export function hostedClientsHint(relay = NO_RELAY) {
  if (relay.state === "none") return null;
  if (relay.state === "not-connected") {
    return [
      "ChatGPT and Claude apps need an Internet-reachable address. Connecting this gateway to an Omnesis account in ",
      ACCOUNT_SETTINGS,
      " gives it one.",
    ];
  }
  const uses = "ChatGPT and Claude apps can use this gateway's Omnesis address.";
  const unavailable = RELAY_UNAVAILABLE[relay.state];
  return unavailable ? [`${uses} ${unavailable.headline} `, ...unavailable.action] : [uses];
}

/** While the dialog is open the page follows the relay closely; otherwise with the overview. */
const RELAY_POLL_OPEN_MS = 5_000;
const RELAY_POLL_IDLE_MS = 30_000;

/**
 * The relay management status, read only where the gateway advertises the
 * feature. A failed read keeps the last answer; before the first one it is null.
 */
export function useRelayStatus(cloudRelay, watching = false) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!cloudRelay) {
      setStatus(null);
      return undefined;
    }
    let current = true;
    const read = () => {
      relayManagement("")
        .then((next) => {
          if (current) setStatus(next);
        })
        .catch(() => {});
    };
    read();
    const timer = setInterval(
      () => {
        if (globalThis.document?.visibilityState !== "hidden") read();
      },
      watching ? RELAY_POLL_OPEN_MS : RELAY_POLL_IDLE_MS,
    );
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [cloudRelay, watching]);
  return status;
}
