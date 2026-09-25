# Omnesis plugin for Claude Code

Connects Claude Code to your own Omnesis gateway and teaches Claude how to use it.

- **One MCP server.** The plugin declares an HTTP MCP server named `omnesis`. When you enable the plugin, Claude Code asks for its **MCP URL**: the HTTPS address ending in `/mcp` shown under **Settings → Access → Connect an agent** in your Omnesis portal. Claude Code then signs in with OAuth; the plugin stores no gateway credential.
- **Three skills.** `omnesis` covers privacy-reviewed Answer and Notes capture, `omnesis-direct` covers the raw read-only Direct tools, and `connect-omnesis` walks through setup and repair. Which tools appear depends on the access level you approve for the connection in Omnesis.

## Install

```text
claude plugin marketplace add omnesis-dev/Omnesis --sparse .claude-plugin plugins/omnesis-claude
claude plugin install omnesis@omnesis --config omnesis_mcp_url=https://gateway.example.org/mcp
```

`--sparse` checks out only the plugin rather than the whole Omnesis repository. Inside Claude Code, `/plugin marketplace add omnesis-dev/Omnesis` and `/plugin install omnesis@omnesis` do the same with a full checkout.

Use your gateway's MCP URL in place of the example. Installing from inside Claude Code asks for it instead, and `/plugin configure omnesis@omnesis` changes it later. Then run `/mcp`, select **omnesis**, choose **Authenticate**, and approve the connection in Omnesis.

Install the plugin or add the server by hand with `claude mcp add`, not both: the plugin declares the same connection.

## Updates

Claude Code does not update plugins from third-party marketplaces unless you turn on auto-update for the marketplace under `/plugin` → **Marketplaces**. To update by hand:

```text
claude plugin marketplace update omnesis
claude plugin update omnesis@omnesis
```

The plugin's version follows the Omnesis release. Its skills treat the live tool list as authoritative, so a plugin newer than your gateway never calls a tool the gateway does not offer.

## Where it does not apply

Claude Code in VS Code and in the Claude desktop app cannot prompt for plugin options; set the URL from a terminal as above. Chats on claude.ai, in the Claude desktop app and in Cowork connect through a custom connector instead. See [Agents & MCP](https://omnesis.dev/docs/connect).
