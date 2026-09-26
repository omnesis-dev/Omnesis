---
"omnesis": patch
---

Pinning a gateway's certificate with `--trust-fingerprint` works behind Tailscale serve or Funnel. The certificate probe now names the host it dials, as every TLS client does; a front that serves several names refused the nameless handshake with "tlsv1 alert internal error", so `omnesis connect openclaw|hermes` and pairing failed there.
