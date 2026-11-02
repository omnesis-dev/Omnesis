---
"omnesis": patch
---

A gateway in Docker's default bridge network no longer offers phones addresses they can never reach. `omnesis devices pair --kind ios|android` and the portal's pairing screen used to list the container's own bridge address and the `omnesis.local` name the gateway announces inside Docker as addresses the phone "can use"; they are now listed as not offered, with the reason. Instead the `omnesis` command on the host records the host's LAN and Tailscale addresses, its `.local` name when the host answers mDNS (macOS, or Linux with avahi), and the port Docker publishes, every time it runs, and the gateway offers those, so a new address from the router is picked up by the next command. The portal's address list for connecting an agent uses the same host addresses. Native installs and Docker's host networking are unchanged.
