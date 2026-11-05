---
"omnesis": patch
"@omnesis/collector": patch
---

A collector registering itself with the gateway now tries again when the request is lost in transit or the gateway answers that it is not ready yet (502, 503 or 504), for about two minutes. A busy gateway can drop that first request even after it answers its health check. The collector used to exit on it, and in a combined Docker install that stopped the whole container, gateway included, until Docker restarted it.
