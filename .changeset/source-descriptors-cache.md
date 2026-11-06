---
"omnesis": patch
---

The list of sources you can add, in the portal, the mobile apps and `omnesis sources add`, no longer takes up to three seconds to open when a collector is busy syncing. The gateway asked every connected collector for its sources on each request and waited for the slowest; it now asks each collector once when it connects, and answers from what it reported. The list is unchanged: a collector that is updated and reconnects shows its new sources at once, and one that goes offline or is revoked is no longer offered.
