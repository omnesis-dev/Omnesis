---
"omnesis": patch
---

`omnesis tls provision` on a machine whose gateway still serves its self-signed certificate now activates the new certificate in the running gateway, as it already did elsewhere. It used to say "Not activated yet (fetch failed)" and ask for `omnesis service restart`, because it reached the gateway without trusting the certificate saved for it; it also skipped the warning about paired phones for the same reason.
