// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The pure half of Settings → Connectivity: which questions the guided setup
// asks for the gateway's features, where it stands between page loads, and
// how one answer about new devices maps onto the relay's and the Tailscale
// device's own policies. Nothing here decides what is trusted: every answer is
// applied through the relay's and the device's own routes, with their checks.

import { relayEstablished, relayPhase } from "../relay.js";

/** The setup's questions, in order. */
export const STEP_LABELS = {
  account: "Your Omnesis account",
  connection: "Remote connection",
  devices: "New devices",
  mcp: "MCP server",
};

/**
 * The steps the setup walks: the account only with the relay; new devices
 * only while a device can ask to join (`devices`: an account is linked or the
 * gateway's own Tailscale device is on); and the MCP server last, only while
 * some address away from home exists to offer it on (`mcp`). A step with
 * nothing to choose is left out.
 */
export function setupSteps({ cloudRelay = false, devices = false, mcp = false } = {}) {
  return [
    ...(cloudRelay ? ["account"] : []),
    "connection",
    ...(devices ? ["devices"] : []),
    ...(mcp ? ["mcp"] : []),
  ];
}

/** Where the setup's progress is kept while the page is away, in this browser tab only. */
export const SETUP_STORAGE_KEY = "omnesis.remote-access.setup";

const MODES = ["setup", "review"];

/**
 * The flow as last saved, or null. Only well-formed values for these `steps`
 * come back, so a stored value from another gateway's features cannot strand
 * the page.
 */
export function loadSetup(steps, storage = globalThis.sessionStorage) {
  let saved;
  try {
    saved = JSON.parse(storage?.getItem(SETUP_STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
  if (!saved || typeof saved !== "object" || !MODES.includes(saved.mode) || !steps.includes(saved.step)) return null;
  return {
    mode: saved.mode,
    step: saved.step,
    resume: steps.includes(saved.resume) ? saved.resume : null,
    // Null until the owner ticks or unticks it: the option then shows whether it is set up.
    host: typeof saved.host === "boolean" ? saved.host : null,
    domain: saved.domain === true,
    url: typeof saved.url === "string" ? saved.url.slice(0, 2048) : "",
  };
}

/** Keeps the flow for a reload or a sign-in that leaves the page; a summary keeps nothing. */
export function saveSetup(flow, storage = globalThis.sessionStorage) {
  try {
    if (flow.mode === "summary") storage?.removeItem(SETUP_STORAGE_KEY);
    else storage?.setItem(SETUP_STORAGE_KEY, JSON.stringify(flow));
  } catch {
    // Without storage the setup starts over after a reload, from what the gateway reports.
  }
}

/** Where the page opens: a saved setup or review resumes (a sign-in can leave the page mid-setup); otherwise the summary. */
export function initialFlow(saved) {
  return saved ?? { mode: "summary" };
}

/**
 * A setup or review from its first step. "My own domain or reverse proxy"
 * starts open when the gateway already has a public address of the owner's;
 * "Tailscale on this computer" opens when chosen, and then looks for it.
 */
export function startFlow(mode, steps, remote) {
  const configured = Boolean(remote.publicBaseUrl?.configured) && !remote.publicBaseUrl?.way;
  return {
    mode,
    step: steps[0],
    resume: null,
    host: null,
    domain: configured,
    url: "",
  };
}

/**
 * What step 1 shows, from the relay's status: `loading`, `unavailable`, `none`
 * (no account yet), the connect phases `waiting`, `registering`, `linking` and
 * `failed`, `linked` (the status reports an Omnesis account link or a Google
 * link), or `enrolled` (registered with the relay but linked to no account).
 */
export function accountState(status) {
  const phase = relayPhase(status);
  if (phase === "not-connected") return "none";
  if (!relayEstablished(phase)) return phase;
  return status.account?.linked || status.google?.linked ? "linked" : "enrolled";
}

/** The answers to "When a new device asks to join", in the order they are offered. */
export const POLICY_CHOICES = {
  ask: {
    short: "Ask me first",
    text: "You approve each one in Settings, Devices, or on your phone.",
  },
  automatic: {
    short: "My devices join automatically",
    text: "A device signed in as you joins at once, and you get a notification.",
  },
  code: {
    short: "Pairing code only",
    text: "New devices need a code from Settings, Devices.",
  },
};

/**
 * The answers offered: a pairing code only while no account is linked, since
 * an account always lets a device ask by signing in (only unlinking stops it).
 */
export function policyChoices({ relayLinked }) {
  return relayLinked ? ["ask", "automatic"] : ["ask", "automatic", "code"];
}

/**
 * The one answer the two policies amount to. `relayPolicy` is the account's
 * (`ask` | `automatic`, undefined while no account is linked) and
 * `tailscalePolicy` the device's (`ask` | `automatic` | `off`, undefined while
 * it is off). `value` is null when neither applies or when they differ;
 * `differ` says which.
 */
export function currentPolicy({ relayPolicy, tailscalePolicy }) {
  const values = [relayPolicy, tailscalePolicy === "off" ? "code" : tailscalePolicy].filter(Boolean);
  if (values.length === 0) return { value: null, differ: false };
  const differ = values.some((value) => value !== values[0]);
  return { value: differ ? null : values[0], differ };
}

/**
 * The changes one answer makes: it is the one setting for every way in, so it
 * sets the account's policy and the device's, wherever each applies.
 */
export function policyChanges(choice, { relayLinked, tailscaleOn }) {
  const changes = [];
  if (relayLinked && choice !== "code") changes.push({ target: "relay", policy: choice });
  if (tailscaleOn) changes.push({ target: "tailscale", policy: choice === "code" ? "off" : choice });
  return changes;
}

/** How the devices step introduces its question, by the ways a new device can ask to join. */
export function joinWays({ relayLinked, tailscaleOn }) {
  const ways = [
    relayLinked ? "by signing in with your Omnesis account" : null,
    tailscaleOn ? "from your Tailscale network" : null,
  ].filter(Boolean);
  if (ways.length === 2) return `One answer for every way a device can ask: ${ways[0]}, or ${ways[1]}.`;
  if (ways.length === 1) return `A new device can ask to join ${ways[0]}.`;
  return "Devices pair with a code from Settings, Devices. With an Omnesis account or the gateway's own Tailscale device, they can ask to join instead.";
}

/** What each side does now, for when the account's and the Tailscale device's policies differ. */
export function policyDifference({ relayPolicy, tailscalePolicy }) {
  const relay = relayPolicy === "automatic" ? "devices that sign in join automatically" : "devices that sign in wait for you";
  const tailscale = {
    automatic: "Tailscale devices join automatically",
    ask: "Tailscale devices wait for you",
    off: "Tailscale devices need a pairing code",
  }[tailscalePolicy];
  return `Right now ${relay} and ${tailscale}. Choose one answer for both.`;
}

/** "a", "a and b", "a, b and c". */
export function listSentence(items) {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
