---
"omnesis": patch
---

One activity Strava keeps failing to serve no longer stops the Strava source. Such an activity used to end every sync on it: the activities behind it were never enriched and new activities stopped being listed until a resync, which met the same activity again. The source now asks for that activity again after half a day, and after its third failure, a day after the first, carries on without that part of it; when Strava itself is down, a sync still stops with the error as before. A batch of long activities' streams larger than the gateway accepts in one request was also sent again on every sync and stopped the source the same way; the source now sends streams in batches the gateway accepts, and stores none for an activity whose streams alone are too large. An activity whose details, comments or kudos Strava refuses is passed over rather than stopping the sync.
