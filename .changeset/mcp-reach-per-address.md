---
"omnesis": minor
---

Settings → Connectivity → MCP server sets how far the MCP server answers on each address: a Tailscale address can keep it to your Tailscale network or put it on the Internet too, and through Tailscale on this computer that publishes the MCP server alone while the portal and your devices' connections stay on your tailnet, unless you tick **Also reachable from the Internet** for them. Agents on the gateway's own machine can always sign in at its localhost address, and **Connect an agent** offers it when no other address answers MCP. Grok bot is listed with ChatGPT and the Claude apps as an agent that needs an address reachable from the Internet, and a Tailscale address kept to your network says so to all three.
