---
"omnesis": patch
---

A Tailscale CLI that hangs no longer stalls Omnesis: the installer, `omnesis tls provision` and the gateway's certificate renewal give each `tailscale status` 10 seconds before moving on to the next place Tailscale may be, and bound `tailscale cert` at five minutes. Before, a hung CLI held the installer for as long as it hung, once per check.
