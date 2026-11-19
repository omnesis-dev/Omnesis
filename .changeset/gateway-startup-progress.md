---
"omnesis": patch
---

The gateway serves a startup progress page before opening its databases and initializing services. Saved portal links open automatically when the gateway is ready. Database preparation runs off the main thread, independent worker pools start in bounded parallel groups, and the portal renders before source metadata finishes loading.
