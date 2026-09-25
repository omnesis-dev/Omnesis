---
name: connect-omnesis
description: Connect ChatGPT to the user's private Omnesis Gateway. Use when the user asks to connect, configure, authenticate, reconnect, or troubleshoot Omnesis in ChatGPT, including the starter "Help me connect Omnesis to ChatGPT." Do not use this skill for Codex CLI setup.
---

# Connect Omnesis

The plugin supplies operating guidance, but it cannot embed a different Gateway URL for every installation. ChatGPT must hold one separate remote MCP connection to the user's Gateway. Because ChatGPT connects from OpenAI's servers, that URL must be Internet-reachable HTTPS; a URL that resolves only inside a tailnet or other private network will not work and may produce no Gateway log entry. If the Gateway has no public address yet, point the user to https://omnesis.dev/docs/connect#tailscale-funnel, which publishes it with Tailscale Funnel and sets `gateway.publicBaseUrl`; the **Connect an agent** dialog appears only once that setting exists. Never give the user `codex mcp` commands from this skill, even if the model or internal runtime identifies itself as Codex. Never ask the user to paste a Portal token, OAuth access token, refresh token, client secret, or certificate private key into the conversation.

## Check whether the connection already works

Inspect the tools available in the current conversation:

- `ask_omnesis` or `get_answer_status` means the connection grants Answer.
- `add_note` means the connection grants Notes, allowing capture without read access.
- Any of `search_many`, `fetch_many`, or `run_sql` means the connection grants Direct.
- Any combination of these capabilities may be present on one connection.

If at least one family is present, do not repeat setup. Explain which capability is available and continue with the user's request. A missing family does not imply that a second MCP URL exists: Omnesis has one `/mcp` resource, and the connection's access level controls which tools appear.

## Connect ChatGPT

ChatGPT connects to a custom MCP server through a developer-mode app on ChatGPT on the web. Developer mode may be unavailable because of the user's plan, role, or workspace policy; explain that limitation if ChatGPT does not expose the controls below. OpenAI's menu names change; when they differ from the steps below, follow https://developers.openai.com/api/docs/guides/developer-mode.

1. Ask the user to open their Omnesis Portal and go to **Settings → Access**.
2. Select **Connect an agent**. In the dialog that opens, copy the **MCP resource** shown in step 1. It is an HTTPS URL ending in `/mcp`. Use that exact value; never invent a hostname, IP address, port, or path.
3. In ChatGPT on the web, turn on developer mode in the settings. If it is unavailable, the account or workspace policy may disable it.
4. Create a developer-mode app for a remote MCP server, enter the exact MCP endpoint copied from Omnesis, and choose OAuth authentication. Create one connection attempt and wait for it to finish. Do not start a second connection or select **Authenticate** again while an authorization window is already open.
5. Review the tools ChatGPT discovers, then select **Authenticate** once if ChatGPT has not already opened authorization.
6. If the authorization page is already signed into the Portal, name the connection, choose its access level, and approve it there. Otherwise copy its short authorization code, return to the authenticated Portal's **Settings → Access** page, select **Connect an agent**, enter the code in the dialog's step 2, configure the connection, and approve it. When ChatGPT was connected before and is signing in again, choose **Replace a connection** and pick the old ChatGPT connection, so it keeps its name and access level and the old sign-in stops working instead of a second connection appearing.
7. Return to ChatGPT, refresh or reconnect Omnesis, and start a new conversation with the Omnesis app enabled.

If several authorization windows or codes appear, do not approve them in sequence. Close all of them, wait until ChatGPT's connection UI is idle, and begin one fresh authentication. Gateway requests that were already created expire automatically. A `127.0.0.1 refused to connect` page means the loopback callback listener is no longer available, which commonly happens after an authentication attempt was abandoned or replaced; close that page and begin one fresh authentication from ChatGPT.

The user chooses Answer, Direct, and Notes independently during approval. Tool availability must follow that choice; every capability arrives through the one `/mcp` endpoint.

## Diagnose without weakening security

- If **Authenticate** is absent or the host says authentication is unsupported, verify that the exact MCP resource opens over browser-trusted HTTPS from the same machine. Do not disable TLS verification.
- If authentication succeeds but expected tools are absent, check the access level the connection uses under **Settings → Access**, ensure the corresponding Gateway capability is operational, refresh the MCP connection, and start a new conversation.
- If the connection intentionally excludes a capability or source, explain that restriction. Never suggest another endpoint or Direct access as a way around an Answer policy decision.
