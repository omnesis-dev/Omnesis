---
"omnesis": patch
---

Hermes: a scheduled job or other tool call no longer fails with "Omnesis corpus authorization needs repair" when the Hermes gateway renewed the Omnesis credential while the tool still held the previous access token. The adapter now renews from the gateway when the token it picked up from disk has already expired.
