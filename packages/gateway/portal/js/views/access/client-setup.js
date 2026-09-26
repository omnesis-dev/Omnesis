// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// How each common agent adds this gateway, with its address already filled in.
// An agent that runs on the user's machine gets commands to paste into a
// terminal; one configured in a web or desktop settings page gets a note that
// points back at the address the dialog already shows. Sign-in is always the
// agent's own OAuth flow against the same resource, so nothing here carries a
// credential.

const SERVER_NAME = "omnesis";

/** POSIX-shell single quoting, so a resource can never split a pasted command. */
function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The agents the Connect dialog offers, in grid order. `icon` is either a
 * bundled image under /portal/img/agents/ or a provider logo the gateway
 * serves; `commands` may be empty for agents configured outside a terminal.
 *
 * @param {string} resource - The gateway's MCP resource URL (ends in `/mcp`).
 * @returns {Array<{
 *   id: string,
 *   name: string,
 *   subtitle: string,
 *   icon: { src: string } | { providerId: string },
 *   commands: Array<{ label: string, value: string }>,
 *   note: string,
 * }>}
 */
export function agentSetups(resource) {
  const url = shellQuote(resource);
  // The managed integrations pair against the gateway itself, not its MCP resource.
  const gateway = shellQuote(resource.replace(/\/mcp$/u, ""));
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
          label: "Or install the plugin, which adds the same server and usage skills",
          value: `claude plugin marketplace add omnesis-dev/Omnesis --sparse .claude-plugin plugins/omnesis-claude && claude plugin install omnesis@omnesis --config omnesis_mcp_url=${url}`,
        },
      ],
      note: "Use one of the two, not both. Then run /mcp, select omnesis and choose Authenticate.",
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
      ],
      note: "Codex opens the sign-in right away. Start a new thread afterwards.",
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      subtitle: "Developer mode",
      icon: { providerId: "openai" },
      commands: [],
      note: "In ChatGPT on the web, turn on developer mode and create an app for a remote MCP server with the address above and OAuth authentication. ChatGPT connects from OpenAI's servers, so the address must be reachable from the Internet.",
    },
    {
      id: "claude-apps",
      name: "Claude apps",
      subtitle: "Connector",
      icon: { src: "/portal/img/agents/claude.svg" },
      commands: [],
      note: "On claude.ai or in the Claude desktop app, open Customize → Connectors and add a custom connector with the address above. Claude connects from Anthropic's servers, so the address must be reachable from the Internet.",
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
      note: "Then run /mcp auth omnesis inside Gemini CLI. Gemini signs in only to a public HTTPS address or a loopback one, not a tailnet or LAN address.",
    },
    {
      id: "openclaw",
      name: "OpenClaw",
      subtitle: "Integration",
      icon: { src: "/portal/img/agents/openclaw.svg" },
      commands: [
        { label: "On the machine that runs OpenClaw", value: `omnesis connect openclaw --gateway-url ${gateway}` },
      ],
      note: "Needs the Omnesis CLI on that machine. It asks for a pairing code from Settings → Devices, then opens this sign-in. Restart OpenClaw afterwards.",
    },
    {
      id: "hermes",
      name: "Hermes",
      subtitle: "Integration",
      icon: { src: "/portal/img/agents/hermes.png" },
      commands: [
        { label: "On the machine that runs Hermes", value: `omnesis connect hermes --gateway-url ${gateway}` },
      ],
      note: "Needs the Omnesis CLI on that machine. It asks for a pairing code from Settings → Devices, then opens this sign-in. Restart Hermes afterwards.",
    },
  ];
}
