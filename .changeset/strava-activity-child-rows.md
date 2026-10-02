---
"omnesis": patch
---

The Strava source keeps each activity's splits, best efforts, laps, segment efforts and zones. Every page that fetched them deleted them again as it wrote them, so those tables stayed empty. Activities enriched before the update stay without them until the source is resynced, from the Sources page or with `omnesis sources resync strava-activities`. A resync fetches every activity again within Strava's daily read limit, four or five reads per activity, so for a large account it takes days.
