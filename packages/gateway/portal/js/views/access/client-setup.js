// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// How each common agent adds this gateway, with this gateway's own values
// filled in, and where the public docs explain that agent's setup. An agent
// that runs on the user's machine gets commands to paste into a terminal; one
// configured in a web or desktop settings page gets a note that points back at
// the address the dialog already shows. Sign-in is always the agent's own
// OAuth flow, so nothing here carries a credential.

const SERVER_NAME = "omnesis";

/** The gateway does not serve the docs; these are the published pages. */
const DOCS = "https://omnesis.dev/docs";
export const PUBLISH_DOCS = {
  funnel: `${DOCS}/connect#tailscale-funnel`,
  domain: `${DOCS}/setup#public-domain`,
};

/** POSIX-shell single quoting, so a value can never split a pasted command. */
function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

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

/**
 * The addresses an agent machine can pair against: every MCP resource the
 * gateway accepts, without its `/mcp`. Ones the gateway serves itself come
 * first, because only there can the machine check the gateway's certificate.
 */
export function harnessAddresses(oauth) {
  const resources = oauth.resources?.length
    ? oauth.resources
    : [{ resource: oauth.resource, servedByGateway: false }];
  return [...resources]
    .sort((left, right) => Number(right.servedByGateway) - Number(left.servedByGateway))
    .map(({ resource, servedByGateway }) => ({
      gatewayUrl: resource.replace(/\/mcp$/u, ""),
      servedByGateway,
    }));
}

function harnessCommands(harness, oauth, address, pairingCode) {
  const flags = [
    `--gateway-url ${shellQuote(address.gatewayUrl)}`,
    ...(pairingCode ? [`--code ${shellQuote(pairingCode)}`] : []),
    ...(address.servedByGateway && oauth.tlsFingerprintSha256
      ? [`--trust-fingerprint sha256:${oauth.tlsFingerprintSha256}`]
      : []),
  ].join(" ");
  return [
    {
      label: "Omnesis not installed",
      value: `curl -fsSL https://omnesis.dev/install.sh | sh -s -- --${harness} ${flags}`,
    },
    { label: "Omnesis CLI installed", value: `omnesis connect ${harness} ${flags}` },
  ];
}

/**
 * The agents the Connect dialog offers, in grid order.
 *
 * - `icon` is a bundled image under /portal/img/agents/ or a provider logo the
 *   gateway serves.
 * - `commands` may be empty for agents configured outside a terminal; with
 *   `alternatives`, they are ways to do the same thing and the user picks one.
 * - `needsPublicAddress` marks agents that reach the gateway from the Internet.
 * - `pairs` marks the managed integrations, which pair the machine they run on
 *   as an agent device before signing in.
 *
 * @param {{ resource: string, resources?: Array<{ resource: string, servedByGateway: boolean }>, tlsFingerprintSha256?: string | null }} oauth
 * @param {{ harnessAddress?: { gatewayUrl: string, servedByGateway: boolean }, pairingCode?: string }} [pairing]
 */
export function agentSetups(oauth, { harnessAddress, pairingCode } = {}) {
  const url = shellQuote(oauth.resource);
  const address = harnessAddress ?? harnessAddresses(oauth)[0];
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      subtitle: "Terminal",
      icon: { src: "/portal/img/agents/claude.svg" },
      commands: [
        {
          label: "Add the server",
          value: `claude mcp add --transport http --scope user ${SERVER_NAME} ${url}`,
        },
        {
          label: "Install the plugin",
          value: `claude plugin marketplace add omnesis-dev/Omnesis --sparse .claude-plugin plugins/omnesis-claude && claude plugin install omnesis@omnesis --config omnesis_mcp_url=${url}`,
        },
      ],
      note: "The plugin adds the same server plus skills that teach Claude to use Omnesis; use one or the other. Then run /mcp, select omnesis and choose Authenticate.",
      alternatives: true,
      docs: `${DOCS}/connect#claude-code`,
    },
    {
      id: "codex",
      name: "Codex",
      subtitle: "Terminal",
      icon: { providerId: "openai" },
      commands: [
        {
          label: "Add the server",
          value: `codex mcp add ${SERVER_NAME} --url ${url} --oauth-resource ${url}`,
        },
        {
          label: "Recommended: add the skills that teach Codex to use Omnesis",
          value:
            "codex plugin marketplace add omnesis-dev/Omnesis --sparse .agents/plugins --sparse plugins/omnesis && codex plugin add omnesis@omnesis",
        },
      ],
      note: "Codex opens the sign-in right away when you add the server. The plugin carries guidance only, so it needs the server either way. Start a new thread afterwards.",
      docs: `${DOCS}/connect#codex`,
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      subtitle: "Developer mode",
      icon: { providerId: "openai" },
      commands: [],
      note: "In ChatGPT on the web, turn on developer mode and create an app for a remote MCP server with the address above and OAuth authentication.",
      needsPublicAddress: "ChatGPT connects from OpenAI's servers",
      docs: `${DOCS}/connect#chatgpt`,
    },
    {
      id: "claude-apps",
      name: "Claude apps",
      subtitle: "Connector",
      icon: { src: "/portal/img/agents/claude.svg" },
      commands: [],
      note: "On claude.ai or in the Claude desktop app, open Customize → Connectors and add a custom connector with the address above.",
      needsPublicAddress: "Claude connects from Anthropic's servers",
      docs: `${DOCS}/connect#claude-desktop`,
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      subtitle: "Terminal",
      icon: { src: "/portal/img/agents/gemini.svg" },
      commands: [
        {
          label: "Add the server",
          value: `gemini mcp add --scope user --transport http ${SERVER_NAME} ${url}`,
        },
      ],
      note: "Then run /mcp auth omnesis inside Gemini CLI.",
      needsPublicAddress: "Gemini CLI signs in only to a public address",
      docs: `${DOCS}/connect#other-clients`,
    },
    {
      id: "openclaw",
      name: "OpenClaw",
      subtitle: "Integration",
      icon: { src: "/portal/img/agents/openclaw.svg" },
      commands: harnessCommands("openclaw", oauth, address, pairingCode),
      note: "Run it on the machine that runs OpenClaw, then restart OpenClaw.",
      alternatives: true,
      pairs: true,
      docs: `${DOCS}/connect#harness-install`,
    },
    {
      id: "hermes",
      name: "Hermes",
      subtitle: "Integration",
      icon: { src: "/portal/img/agents/hermes.png" },
      commands: harnessCommands("hermes", oauth, address, pairingCode),
      note: "Run it on the machine that runs Hermes, then restart Hermes.",
      alternatives: true,
      pairs: true,
      docs: `${DOCS}/connect#harness-install`,
    },
  ];
}
