---
"omnesis": patch
---

On a Mac with Homebrew's Tailscale, the gateway can renew its Tailscale certificate and find the tailnet for pairing addresses: it now looks for `tailscale` in Homebrew's bin directories when its service PATH does not include them, as on Apple Silicon. The installer looks there too when it is run from a shell whose PATH lacks them.
