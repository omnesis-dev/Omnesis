---
"omnesis": patch
---

Connecting Strava asks for Strava's permission to read activities as well as the one for private activities, so an athlete who unticks private activities on Strava's authorization screen still has a source that syncs their other activities, and one who unticks every activity box is asked to connect again instead of seeing an unexplained error on every sync. While a grant leaves private activities out, those already synced are removed; connecting again with the box ticked brings them back at the next daily check of the activity list. The sign-in now says what each unticked box leaves out, also when it goes through the gateway's public address, and the setup wizard asks for that address's host name as the callback domain.
