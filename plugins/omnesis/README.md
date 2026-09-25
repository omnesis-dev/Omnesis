# Omnesis agent plugin

Teaches an agent how to use your own Omnesis gateway: privacy-reviewed **Answer**, raw read-only **Direct**, and **Notes** capture, each available only when the access level you approve for the connection includes it. It is a portable [agent-plugins.org](https://agent-plugins.org) 1.0 package, read by Codex, ChatGPT, GitHub Copilot CLI and VS Code.

The plugin carries guidance only. Each gateway has its own address, so you add the gateway's MCP server to your client separately; the portal's **Settings → Access → Connect an agent** dialog lists the command or install link for each client with your address filled in. Claude Code has its own plugin in `plugins/omnesis-claude`, which declares the server too.

## Skills

- `omnesis` — ask through Answer and save notes.
- `omnesis-direct` — search and read through the Direct tools.
- `connect-omnesis-chatgpt`, `connect-omnesis-codex`, `connect-omnesis-editor` — set up or repair the connection in ChatGPT, the Codex CLI, or VS Code, Copilot CLI and Cursor.

## Install

```text
codex plugin marketplace add omnesis-dev/Omnesis --sparse .agents/plugins --sparse plugins/omnesis
codex plugin add omnesis@omnesis

copilot plugin marketplace add omnesis-dev/Omnesis
copilot plugin install omnesis@omnesis
```

In VS Code, add `omnesis-dev/Omnesis` to the `chat.plugins.marketplaces` setting and install `omnesis` from the plugin list. See [Agents & MCP](https://omnesis.dev/docs/connect) for the connection itself.
