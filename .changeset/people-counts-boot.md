---
"@omnesis/gateway": patch
---

The gateway no longer recomputes every person's document and alias counts in one read at boot. On a large people graph that read held the only io worker for minutes, and every user read queued behind it, search's readability check among them, waited for it. The periodic sweep refreshes the counts in bounded chunks, and runs on a first boot too.
