---
"omnesis": patch
---

When the gateway cannot renew a Tailscale certificate, its error now names the real reason: a Tailscale CLI that answered but is not connected (for example logged out) is reported with its state, and when no CLI could be run at all, every place the gateway looked is listed along with its PATH. Before, it named only the last place it looked, which on a Mac was usually a Tailscale app that was never installed.
