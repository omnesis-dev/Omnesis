---
"omnesis": patch
---

After `omnesis tls provision` replaces a self-signed certificate with a Tailscale one, the collector on the gateway's own machine reconnects. Its service still dialled `https://localhost`, which the new certificate does not cover, so it waited forever on "its certificate changed … and is not trusted here". Provision now regenerates that collector's service definition by the rule `omnesis service install` and `omnesis update` use, so it dials the name the certificate covers, and restarts it.
