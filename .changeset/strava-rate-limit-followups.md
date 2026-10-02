---
"omnesis": patch
---

The Strava source keeps listing new activities while it works through a backlog of activity details, comments, zones and streams. A batch the rate limit could not cover used to hold back the whole source, and new activities waited with it; working through the backlog now stops at 80% of Strava's limits, which leaves the listing reads of its own. When Strava itself refuses a request as over its limit, the source now reads which window is spent from the read limit as well, the one a new Strava app reaches first, and waits until that window resets: until midnight UTC once the day is spent, rather than trying again every quarter hour, or every hour once the overall day was spent.

An athlete with more gear than one 15-minute window of reads can fetch no longer stops the source: the athlete refresh waited for a window that could cover all of its gear at once, which never came, and new activities waited behind it. It now fetches what each window allows and carries on in the windows after. A newly added Strava source syncs every 30 minutes rather than every 5. A Strava source added earlier keeps the interval it has; `omnesis config set /sources/strava-activities/syncInterval 30m` gives it the new one.
