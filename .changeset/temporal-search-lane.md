---
"omnesis": minor
---

Search reads the time a query names ("last week", "invoice from March", "Q3 2025", "15 juin") and adds a third ranking lane for the documents written in that window or about a day in it, such as calendar events, bookings and dates mentioned in text, beside keyword and semantic ranking. The time phrase is read from the asker's current time and time zone, which the portal, the CLI and the agents send. `search.temporal.enabled` (default `true`) and `search.temporal.weight` (default 1) tune it.
