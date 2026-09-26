# Omnesis agent plugin

Teaches an agent how to use your own Omnesis gateway: privacy-reviewed **Answer**, raw read-only **Direct**, and **Notes** capture, each available only when the access level you approve for the connection includes it. It is a portable [agent-plugins.org](https://agent-plugins.org) 1.0 package for Codex and ChatGPT.

The plugin carries guidance only. Each gateway has its own address, so you add the gateway's MCP server to your client separately; the portal's **Settings → Access → Connect an agent** dialog lists the command for each common agent with your address filled in. Claude Code has its own plugin in `plugins/omnesis-claude`, which declares the server too.

## Skills

- `omnesis` — ask through Answer and save notes.
- `omnesis-direct` — search and read through the Direct tools.
- `connect-omnesis-chatgpt`, `connect-omnesis-codex` — set up or repair the connection in ChatGPT or the Codex CLI.

## Install

```text
codex plugin marketplace add omnesis-dev/Omnesis --sparse .agents/plugins --sparse plugins/omnesis
codex plugin add omnesis@omnesis
```

The repository also lists this plugin in `.github/plugin/marketplace.json`, which GitHub Copilot CLI and VS Code read before `.claude-plugin/`, so a coding host pointed at the repository loads this guidance rather than the Claude plugin. See [Agents & MCP](https://omnesis.dev/docs/connect) for the connection itself.
