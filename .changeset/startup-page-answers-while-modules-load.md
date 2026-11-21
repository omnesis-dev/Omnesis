---
"omnesis": patch
---

The startup page answers for the whole of the gateway's start. While the gateway loaded its own code, which can take seconds, the page and every other request to the gateway went unanswered. The gateway now loads that code a few modules at a time and answers between them.
