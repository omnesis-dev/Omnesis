---
"omnesis": patch
---

Two Strava accounts synced into one gateway no longer stop each other. When it chose which activities to enrich, each account's source also read the other account's, fetched them with its own token and wrote them back as the other athlete's, which the gateway refuses; the refused write was retried on every sync, so the source stopped listing new activities, and what it had stored of the other account's activity could stop that account's source too. Each source now reads only its own athlete's activities. Strava sources already stopped this way start again once every Strava source on the gateway is resynced, from the Sources page or all at once with `omnesis sources resync strava-activities`.
