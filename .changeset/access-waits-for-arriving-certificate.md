---
"omnesis": patch
---

The portal's Access page no longer tells you to set up another certificate for an address whose trusted certificate is still being issued, such as the gateway's own Tailscale device or its Omnesis relay address just after they are turned on. It says the certificate is on its way, checks again every ten seconds, and opens the agent's setup once it lands. An address that did not answer the gateway's certificate check is also checked again on the next visit instead of being remembered as untrusted for a minute.
