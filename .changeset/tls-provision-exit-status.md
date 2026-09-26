---
"omnesis": patch
---

`omnesis tls provision` now exits non-zero when it provisions nothing: when no trusted-certificate path is available, when `tailscale cert` or mkcert fails, and when a certificate is already wired and `--force` was not given. It printed the right guidance before but always exited 0, so scripts could not tell.
