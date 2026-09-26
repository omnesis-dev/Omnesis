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
const DEVELOPER_MODE_GUIDE = "https://developers.openai.com/api/docs/guides/developer-mode";
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

/** Whether an https address names a port other than 443. */
export function usesNonStandardPort(resource) {
  try {
    return new URL(resource).port !== "";
  } catch {
    return false;
  }
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
 * - `note` is a list of text parts: a string, `{ code }` for a command name,
 *   or `{ href, text }` for a link. `headless`, when present, says how to
 *   finish the sign-in on a machine without a browser, with an optional
 *   command to run there.
 * - `needsPublicAddress` marks agents that reach the gateway from the Internet,
 *   and `standardPortOnly` those that only dial port 443. With an address such
 *   an agent cannot reach, it is `blocked` and has no commands or
 *   instructions, because none of them could work.
 * - `pairs` marks the managed integrations, which pair the machine they run on
 *   as an agent device before signing in.
 *
 * @param {{ resource: string, resources?: Array<{ resource: string, servedByGateway: boolean }>, tlsFingerprintSha256?: string | null }} oauth
 * @param {{ harnessAddress?: { gatewayUrl: string, servedByGateway: boolean }, pairingCode?: string }} [pairing]
 */
export function agentSetups(oauth, { harnessAddress, pairingCode } = {}) {
  const url = shellQuote(oauth.resource);
  const address = harnessAddress ?? harnessAddresses(oauth)[0];
  const privateAddress = isPrivateAddress(oauth.resource);
  const agents = [
    {
      id: "claude-code",
      name: "Claude Code",
      icon: { src: "/portal/img/agents/claude.svg" },
      commands: [
        {
          label: "Install the plugin (recommended)",
          value: `claude plugin marketplace add omnesis-dev/Omnesis --sparse .claude-plugin plugins/omnesis-claude && claude plugin install omnesis@omnesis --config omnesis_mcp_url=${url}`,
        },
        {
          label: "Only add the server",
          value: `claude mcp add --transport http --scope user ${SERVER_NAME} ${url}`,
        },
      ],
      note: [
        "Then run ",
        { code: "/mcp" },
        " in Claude Code, select omnesis and choose Authenticate. The plugin adds the same server plus skills that teach Claude to use Omnesis.",
      ],
      headless: {
        note: [
          "Claude Code prints a sign-in link. Open it on a device with a browser and approve, then paste the address that browser lands on into Claude Code, even if the page does not load.",
        ],
      },
      alternatives: true,
      docs: `${DOCS}/connect#claude-code`,
    },
    {
      id: "codex",
      name: "Codex",
      icon: { providerId: "openai" },
      commands: [
        {
          label: "1) Add the server",
          value: `codex mcp add ${SERVER_NAME} --url ${url} --oauth-resource ${url}`,
        },
        {
          label: "2) Recommended: add the skills that teach Codex to use Omnesis",
          value:
            "codex plugin marketplace add omnesis-dev/Omnesis --sparse .agents/plugins --sparse plugins/omnesis && codex plugin add omnesis@omnesis",
        },
      ],
      note: [
        "Needs Codex 0.147 or later: check with ",
        { code: "codex --version" },
        " and run ",
        { code: "codex update" },
        " if it is older. Codex opens the sign-in as soon as you add the server. The plugin carries guidance only, so it needs the server either way. Start a new thread afterwards.",
      ],
      headless: {
        note: [
          "Adding the server starts a sign-in that cannot finish here. Once Codex says the server is added, press Ctrl+C and sign in with the command below: open the link it prints on a device with a browser, approve, then paste the address that browser lands on, even if the page does not load.",
        ],
        command: `codex mcp login ${SERVER_NAME} --no-browser`,
      },
      docs: `${DOCS}/connect#codex`,
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      icon: { providerId: "openai" },
      commands: [],
      note: [
        "In ChatGPT on the web, turn on ",
        { href: DEVELOPER_MODE_GUIDE, text: "developer mode" },
        " and create an app for a remote MCP server with the address above and OAuth authentication.",
      ],
      needsPublicAddress: "ChatGPT connects from OpenAI's servers",
      standardPortOnly: "ChatGPT connects only on the standard HTTPS port, 443",
      docs: `${DOCS}/connect#chatgpt`,
    },
    {
      id: "claude-apps",
      name: "Claude apps",
      icon: { src: "/portal/img/agents/claude.svg" },
      commands: [],
      note: [
        "On claude.ai or in the Claude desktop app, open Customize → Connectors and add a custom connector with the address above.",
      ],
      needsPublicAddress: "Claude connects from Anthropic's servers",
      docs: `${DOCS}/connect#claude-desktop`,
    },
    {
      id: "antigravity",
      name: "Antigravity",
      icon: { src: "/portal/img/agents/antigravity.svg" },
      commands: [{ label: "Add the server", value: `agy mcp add ${SERVER_NAME} ${url}` }],
      note: [
        "Then run ",
        { code: "/mcp" },
        " in Antigravity CLI, select omnesis and choose Authenticate, then approve in the browser that opens, or open the link it prints on any device. After you approve, the browser opens an Antigravity page with an authorization code: copy it and paste it into Antigravity.",
      ],
      docs: `${DOCS}/connect#antigravity`,
    },
    {
      id: "openclaw",
      name: "OpenClaw",
      icon: { src: "/portal/img/agents/openclaw.svg" },
      commands: harnessCommands("openclaw", oauth, address, pairingCode),
      note: ["Run it on the machine that runs OpenClaw, then restart OpenClaw."],
      alternatives: true,
      pairs: true,
      docs: `${DOCS}/connect#harness-install`,
    },
    {
      id: "hermes",
      name: "Hermes",
      icon: { src: "/portal/img/agents/hermes.png" },
      commands: harnessCommands("hermes", oauth, address, pairingCode),
      note: ["Run it on the machine that runs Hermes, then restart Hermes."],
      alternatives: true,
      pairs: true,
      docs: `${DOCS}/connect#harness-install`,
    },
  ];
  const nonStandardPort = usesNonStandardPort(oauth.resource);
  return agents.map((agent) =>
    (agent.needsPublicAddress && privateAddress) || (agent.standardPortOnly && nonStandardPort)
      ? { ...agent, blocked: true, commands: [], note: [], headless: undefined }
      : agent,
  );
}
