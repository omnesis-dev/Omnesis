---
"omnesis": patch
---

The portal's Connect an agent dialog shows a grid of general agents, each with its own icon: Claude Code, Codex, ChatGPT, the Claude apps, Gemini CLI, OpenClaw and Hermes. Choosing one shows only that agent's setup, with the gateway's address filled in and a link to its section of the docs. Agents that connect from the Internet name a private address as one they cannot reach and link to publishing the gateway. OpenClaw and Hermes show the one-line installer and the `omnesis connect` command with a pairing code minted in place and, where the gateway serves the address itself, its certificate fingerprint. The access overview (`GET /admin/access`) now lists every MCP resource the gateway accepts, whether it serves each one itself, and its certificate fingerprint. The editor entries and the editor setup skill are gone; any other OAuth-capable MCP client still connects with the MCP URL.
