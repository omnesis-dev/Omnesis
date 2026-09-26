---
"omnesis": patch
---

Keep `omnesis` commands working on the gateway's own machine while Tailscale is down. Once the gateway serves a Tailscale certificate, the address recorded for other machines is its tailnet name, and the CLI and collector beside the gateway kept dialling that name, which stops resolving when Tailscale is disconnected — so every command failed with "Cannot reach gateway" although the gateway was running. They now reach the gateway over loopback by that same name, still verifying its certificate against the name it was issued for.
