---
"omnesis": patch
---

The installer now tries again when Tailscale or Let's Encrypt fails a certificate order with a server error or turns one order down, waiting 10 and then 30 seconds between tries. Before, one such failure left the install on the self-signed certificate until the installer was run again. A refusal that names a setting to fix, such as HTTPS certificates being off for the tailnet, is still reported at once.
