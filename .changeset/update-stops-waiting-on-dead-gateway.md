---
"omnesis": patch
---

An update whose new gateway exits on boot rolls back within seconds instead of waiting out the whole ten-minute health wait. Between health probes the update now asks systemd or launchd whether the gateway is still running, and rolls back once the service manager has relaunched it twice or has held no gateway process for 15 seconds. A gateway that is still running keeps the whole wait, so a long migration is never cut short.
