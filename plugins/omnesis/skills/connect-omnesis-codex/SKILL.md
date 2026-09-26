---
name: connect-omnesis-codex
description: Configure the user's private Omnesis Gateway in the Codex CLI. Use when working in the Codex CLI or when the user names Codex, Codex CLI, or codex mcp commands. Do not use for ChatGPT on the web, ChatGPT desktop, or ChatGPT Work.
---

# Connect Omnesis to Codex

Use the exact MCP resource copied from the **Connect an agent** dialog on the Omnesis Portal's **Settings → Access** page. It is an HTTPS URL ending in `/mcp`.

```text
codex mcp add omnesis --url <MCP_RESOURCE> --oauth-resource <MCP_RESOURCE>
```

This needs Codex 0.147 or later: earlier versions cannot complete the gateway's sign-in and stop with "Authorization server response missing required issuer". Check with `codex --version` and, if it is older, run `codex update`, which updates Codex however it was installed.

Replace `<MCP_RESOURCE>` locally. Codex detects the gateway's OAuth support and opens the sign-in right away, requesting the scopes the gateway advertises, so no separate login command is needed. Complete the authorization and approve the connection in Omnesis, then start a new Codex thread so the authenticated tool catalogue loads. When this Codex installation was connected before and is signing in again, choose **Replace a connection** during approval so the old sign-in stops working instead of a second connection appearing.

To sign in again later, for example after the connection was removed in Omnesis, run `codex mcp login omnesis`. Never ask the user to paste a Portal token, OAuth access token, refresh token, client secret, or certificate private key into the conversation.

The owner selects Answer, Direct, and Notes independently during approval. Enable Notes to expose `add_note` for saving to “Tell Omnesis”; it grants no corpus read access.
