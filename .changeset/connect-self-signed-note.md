---
"omnesis": patch
---

The Connect an agent dialog no longer shows Claude Code or Codex setup commands that cannot work on a gateway serving its self-signed certificate. Both agents accept only a publicly issued certificate, so their cards now say so and link to setting up a Tailscale certificate or a domain. The access overview reports whether each MCP address serves a publicly trusted certificate.
