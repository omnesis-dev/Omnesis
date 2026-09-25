---
name: connect-omnesis-codex
description: Configure the user's private Omnesis Gateway in the Codex CLI. Use only when the user explicitly names Codex, Codex CLI, or asks for codex mcp commands. Do not use for ChatGPT desktop or ChatGPT Work.
---

# Connect Omnesis to Codex

Use the exact MCP resource copied from the **Connect an agent** dialog on the Omnesis Portal's **Settings → Access** page. It is an HTTPS URL ending in `/mcp`.

```text
codex mcp add omnesis --url <MCP_RESOURCE> --oauth-client-registration dcr --oauth-resource <MCP_RESOURCE>
codex mcp login omnesis --scopes omnesis:access,offline_access
```

Replace `<MCP_RESOURCE>` locally. Never ask the user to paste a Portal token, OAuth access token, refresh token, client secret, or certificate private key into the conversation. Complete the authorization and approve the connection in Omnesis, then start a new Codex thread so the authenticated tool catalogue loads. When this Codex installation was connected before and is signing in again, choose **Replace a connection** during approval so the old sign-in stops working instead of a second connection appearing.

The owner selects Answer, Direct, and Notes independently during approval. Enable Notes to expose `add_note` for saving to “Tell Omnesis”; it grants no corpus read access.
