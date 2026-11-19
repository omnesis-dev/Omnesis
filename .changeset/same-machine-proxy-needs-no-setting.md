---
"omnesis": patch
---

A proxy on the gateway's own machine, such as Tailscale Funnel, Caddy or nginx, no longer needs `OMNESIS_TRUST_PROXY=true` or a restart: the gateway believes the client address such a proxy reports, so its rate limits apply to each Internet client. Publishing the gateway through Tailscale Funnel from Settings no longer asks for the setting first. `OMNESIS_TRUST_PROXY` is now needed only for a proxy on another machine.
