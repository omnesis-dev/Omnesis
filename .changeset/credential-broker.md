---
"omnesis": minor
---

An account can take its credential from a self-hosted Nango instead of a sign-in here. `omnesis broker set` points the collector at Nango, `omnesis broker link` binds an account to one or more Nango connections after confirming whose account each is, and `omnesis sources add` then offers that account without asking for a credential. Notion, Google, Outlook, Strava, GitHub, Granola, Lunch Flow, Coinbase and IMAP support it. Each credential the broker hands out is checked against the linked account before it is used, `omnesis broker status` runs the same check, and a brokered account that needs a new sign-in says to sign in again at the broker. Removing a brokered source removes only the link, never the grant.
