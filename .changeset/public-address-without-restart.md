---
"omnesis": patch
---

A public address saved in `gateway.publicBaseUrl`, from the portal's Remote access setup or with `omnesis config set`, takes effect at once: MCP sign-in, agent discovery, phone pairing and source sign-in callbacks use it without a gateway restart, and so do the extra addresses in `gateway.mcpResourceUrls`. When `OMNESIS_PUBLIC_BASE_URL` sets the address, the portal shows it and says it can't be changed there.
