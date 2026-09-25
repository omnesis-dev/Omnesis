---
name: connect-omnesis
description: Connect Claude Code to the user's private Omnesis gateway, or repair that connection. Use when the user asks to connect, configure, authenticate, reconnect, or troubleshoot Omnesis in Claude Code, or when Omnesis tools are missing.
---

# Connect Omnesis

This plugin declares one HTTP MCP server named `omnesis`. Its URL is the plugin option **MCP URL**; Claude Code signs in to it with OAuth and stores and refreshes the tokens itself. Never ask the user to paste a Portal token, OAuth access token, refresh token, client secret, or certificate private key into the conversation.

## Check whether the connection already works

Inspect the tools available in the current conversation:

- `ask_omnesis` or `get_answer_status` means the connection grants Answer.
- `add_note` means the connection grants Notes, allowing capture without read access.
- Tools such as `search_many` and `fetch_many` mean the connection grants Direct.

If at least one family is present, do not repeat setup. Explain which capability is available and continue with the user's request. A missing family does not imply that a second MCP URL exists: Omnesis has one `/mcp` resource, and the connection's access level controls which tools appear.

## Connect

1. Ask the user to open their Omnesis Portal, go to **Settings → Access**, select **Connect an agent**, and copy the **MCP resource**. It is an HTTPS URL ending in `/mcp`. Use that exact value; never invent a hostname, IP address, port, or path. Claude Code runs on the user's machine, so an address reachable only on their tailnet or home network works, as long as the gateway lists it.
2. If the plugin has no MCP URL yet, have the user run `/plugin configure omnesis@omnesis` and paste it there, or run `claude plugin install omnesis@omnesis --config omnesis_mcp_url=<MCP_RESOURCE>` in a terminal. Both also change it later.
3. Have the user run `/mcp`, select **omnesis**, and choose **Authenticate**. Claude Code opens the Omnesis sign-in page in the browser.
4. On that page, the user names the connection, chooses its access level, and approves it. When this Claude Code installation was connected before and is signing in again, choose **Replace a connection** and pick the old one, so it keeps its name and access level and the old sign-in stops working instead of a second connection appearing.
5. Start a new conversation so the authenticated tool list loads.

The owner chooses Answer, Direct, and Notes independently during approval. Every capability arrives through the one `/mcp` endpoint.

## Where the plugin cannot ask for the URL

Claude Code in VS Code and in the Claude desktop app cannot prompt for plugin options. Set the URL first with `/plugin configure` in Claude Code in a terminal, or with `--config` as above. If the server still has no URL there, add it by hand instead of using the plugin's connection:

```text
claude mcp add --transport http --scope user omnesis <MCP_RESOURCE>
```

Chats on claude.ai, in the Claude desktop app, and in Cowork connect from Anthropic's servers rather than the user's computer. They use a custom connector at a public HTTPS address; see https://omnesis.dev/docs/connect.

## Diagnose without weakening security

- If sign-in fails or never starts, check that the exact MCP resource opens over browser-trusted HTTPS from the same machine. Do not disable TLS verification.
- If sign-in succeeds but expected tools are absent, check the access level the connection uses under **Settings → Access**, ensure the corresponding gateway capability is operational, run `/mcp` to reconnect, and start a new conversation.
- If the connection intentionally excludes a capability or source, explain that restriction. Never suggest another endpoint or Direct access as a way around an Answer policy decision.
