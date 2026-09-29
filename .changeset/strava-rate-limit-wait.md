---
"omnesis": patch
---

The Strava source no longer spins when it runs out of API budget. It used to ask for the same empty page dozens of times a second, each one a round trip to the gateway, and because it never let go of usage counted in a window that had already reset, the loop did not end when the window did. It now shows as rate-limited and waits until Strava's 15-minute or daily window resets.
