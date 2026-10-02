---
"omnesis": patch
---

Strava's open-ended top heart-rate or power zone is stored with no upper bound (`max_value` null) instead of `-1`, which read as a bound below every other zone's, so a query such as `max_value < 150` counted the top zone among the lowest. The descriptions of the cadence, workout type and zone points columns now say what Strava reports in them. The athlete's zones change at the next weekly athlete refresh; an activity's zones already stored change after a resync, from the Sources page or with `omnesis sources resync strava-activities`.
