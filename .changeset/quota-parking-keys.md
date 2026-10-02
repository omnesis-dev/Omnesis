---
"omnesis": patch
---

When a Strava account runs into the rate limit Strava counts against the API application, the other Strava accounts a collector connects through that application now also show as rate limited, not only the one that hit it. A rate limit counted against one account no longer shows another provider's sources as rate limited because they are signed in with the same account name, such as a mailbox and a note-taking app on one email address. This changes only which sources show as rate limited.
