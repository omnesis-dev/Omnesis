---
name: connect-omnesis-editor
description: Connect VS Code, GitHub Copilot CLI, or Cursor to the user's private Omnesis Gateway. Use only when the user is working in one of those hosts and asks to connect, configure, authenticate, or repair Omnesis. Do not use for ChatGPT or Codex.
---

# Connect Omnesis to VS Code, Copilot CLI, or Cursor

This plugin carries guidance only. The connection itself is one HTTP MCP server named `omnesis` that the user adds to their host, pointing at their own gateway. Never ask the user to paste a Portal token, OAuth access token, refresh token, client secret, or certificate private key into the conversation.

## Check whether the connection already works

Inspect the tools available in the current conversation:

- `ask_omnesis` or `get_answer_status` means the connection grants Answer.
- `add_note` means the connection grants Notes, allowing capture without read access.
- Tools such as `search_many` and `fetch_many` mean the connection grants Direct.

If at least one family is present, do not repeat setup. A missing family does not imply that a second MCP URL exists: Omnesis has one `/mcp` resource, and the connection's access level controls which tools appear.

## Add the server

Ask the user to open their Omnesis Portal, go to **Settings → Access**, select **Connect an agent**, and open **Commands and install links for common clients**. It lists the setup for each host with their gateway's MCP resource already filled in. Never invent a hostname, IP address, port, or path.

- **VS Code:** select **Install in VS Code**, or run **MCP: Add Server** from the Command Palette, choose HTTP, and enter the MCP resource. VS Code signs in when the server first starts.
- **Cursor:** select **Install in Cursor**, then sign in from Cursor's MCP settings.
- **GitHub Copilot CLI:** run `copilot mcp add --transport http omnesis <MCP_RESOURCE>` in a terminal, replacing `<MCP_RESOURCE>` locally, then sign in with `/mcp auth omnesis` inside Copilot CLI if it does not prompt on its own.

On the Omnesis sign-in page, the user names the connection, chooses its access level, and approves it. When this host was connected before and is signing in again, choose **Replace a connection** so the old sign-in stops working instead of a second connection appearing. Then start a new chat so the tools load.

## Diagnose without weakening security

- If sign-in fails, check that the MCP resource opens over browser-trusted HTTPS from the same machine. Do not disable TLS verification.
- If sign-in succeeds but expected tools are absent, check the access level the connection uses under **Settings → Access**, restart the server from the host's MCP list, and start a new chat.
- Never suggest another endpoint or Direct access as a way around an Answer policy decision.
