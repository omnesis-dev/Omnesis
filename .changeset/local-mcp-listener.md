---
"omnesis": minor
---

Agents on the gateway's own computer can reach the MCP server at `http://localhost:7601/mcp` (the gateway's port plus one) with no certificate to trust. The gateway listens there on loopback only, by default. If another program already uses that port the gateway starts without it and says so; to free it, set `gateway.localMcp.enabled` to `false` or choose another port with `gateway.localMcp.port` or `OMNESIS_LOCAL_MCP_PORT`.
