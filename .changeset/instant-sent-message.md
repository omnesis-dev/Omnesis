---
"omnesis": patch
---

Show a sent message the instant it is sent in the portal, iOS, and Android. A message that starts a turn appears in the transcript before the gateway confirms it, and a follow-up sent while a turn is running appears on the queue card without first disappearing. The gateway's user-message event names the submissions it accepted, so the early bubble is renamed rather than repeated, and a refused send withdraws it so the retry card stands alone.
