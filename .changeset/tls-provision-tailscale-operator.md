---
"omnesis": patch
---

On Linux, `omnesis tls provision` now takes the Tailscale operator permission for your account when tailscaled refuses it a certificate ("Access denied: cert access denied"), as the installer already did, and mints the certificate. It asks through sudo or doas only where a password prompt can be answered, or where none is needed; otherwise it names the command to run, as before. It also records the MagicDNS address as one phones verify through their own system trust (`OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN`), as the installer does.
