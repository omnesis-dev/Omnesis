---
"omnesis": patch
---

A source whose icon host is slow or unreachable no longer holds up each sync page. The gateway fetches a source's icon and its family's icon at the same time, once when they share an address, and remembers a failed fetch for five minutes instead of waiting for it again on every page. Each page used to wait up to 30 seconds while the host was down.
