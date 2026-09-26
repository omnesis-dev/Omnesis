// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// How each common agent adds this gateway, with its address already filled in:
// a command to paste into a terminal or, for clients configured in a web or
// desktop settings page, a note pointing back at the address the dialog
// already shows. Sign-in
// is always the client's own OAuth flow against the same resource, so nothing
// here carries a credential.

const SERVER_NAME = "omnesis";

/** POSIX-shell single quoting, so a resource can never split a pasted command. */
function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The per-client setup entries for one MCP resource, in the order the dialog
 * lists them.
 *
 * @param {string} resource - The gateway's MCP resource URL (ends in `/mcp`).
 * @returns {Array<{ id: string, client: string, kind: "command" | "note", value: string, note: string }>}
 */
export function clientSetups(resource) {
  const url = shellQuote(resource);
  // The managed integrations pair against the gateway itself, not its MCP resource.
  const gateway = shellQuote(resource.replace(/\/mcp$/u, ""));
  return [
    {
      id: "claude-code",
      client: "Claude Code",
      kind: "command",
      value: `claude mcp add --transport http --scope user ${SERVER_NAME} ${url}`,
      note: "Then run /mcp, select omnesis and choose Authenticate.",
    },
    {
      id: "claude-code-plugin",
      client: "Claude Code plugin",
      kind: "command",
      value: `claude plugin marketplace add omnesis-dev/Omnesis --sparse .claude-plugin plugins/omnesis-claude && claude plugin install omnesis@omnesis --config omnesis_mcp_url=${url}`,
      note: "Adds the same server plus usage skills. Use it instead of the line above, not as well; then sign in from /mcp.",
    },
    {
      id: "codex",
      client: "Codex",
      kind: "command",
      value: `codex mcp add ${SERVER_NAME} --url ${url} --oauth-resource ${url}`,
      note: "Codex opens the sign-in right away. Start a new thread afterwards.",
    },
    {
      id: "gemini-cli",
      client: "Gemini CLI",
      kind: "command",
      value: `gemini mcp add --scope user --transport http ${SERVER_NAME} ${url}`,
      note: "Then run /mcp auth omnesis inside Gemini CLI. Gemini signs in only to a public HTTPS address or a loopback one, not a tailnet or LAN address.",
    },
    {
      id: "openclaw",
      client: "OpenClaw",
      kind: "command",
      value: `omnesis connect openclaw --gateway-url ${gateway}`,
      note: "Run where OpenClaw runs, with the Omnesis CLI installed. It asks for a pairing code from Settings → Devices, then opens this sign-in. Restart OpenClaw afterwards.",
    },
    {
      id: "hermes",
      client: "Hermes",
      kind: "command",
      value: `omnesis connect hermes --gateway-url ${gateway}`,
      note: "Run where Hermes runs, with the Omnesis CLI installed. It asks for a pairing code from Settings → Devices, then opens this sign-in. Restart Hermes afterwards.",
    },
    {
      id: "hosted",
      client: "ChatGPT, Claude apps",
      kind: "note",
      value: "",
      note: "Add a custom connector or developer-mode app with the address above. They connect from their provider's servers, so it must be reachable from the Internet.",
    },
  ];
}
