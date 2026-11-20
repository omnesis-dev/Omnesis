---
"omnesis": minor
---

The gateway can join your Tailscale network as a device of its own, with no Tailscale app on its machine: turn it on in **Settings → Tailscale**. It stays off, and writes nothing, until you do. A source install now builds the small Tailscale helper program this needs whenever it installs or updates, with the Go already on the machine or a pinned Go release it downloads from go.dev and checks (about 1.5 GB in the checkout); if that build fails, the install or update completes without the device and says why. The Docker image already includes the program. Its public address for cloud agents is now chosen with the other addresses under **MCP server**.
