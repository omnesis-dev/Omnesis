---
"omnesis": patch
---

Pairing the browser extension now warns when it cannot work. A gateway serving a self-signed, expired or not-yet-valid certificate is one the Chrome extension can never reach, because it cannot click through a certificate warning; `omnesis devices pair --kind browser`, `omnesis devices repair` for a browser and the portal's pairing dialog now say so beside the code, with the fix (re-run the installer with Tailscale up, or `omnesis tls provision` on a native install) and a link to the setup guide. A mkcert certificate, or one you supplied, gets a softer note. The code is still issued. `omnesis devices pair` gains `--json`, whose record carries `browserCertificate.status` for scripts.
