---
"omnesis": patch
---

On macOS, a collector that dies without a clean exit now always comes back — whether it crashed, was killed by its event-loop watchdog, or was killed outright, for example by the system when memory runs out. launchd can hold back the respawn a LaunchAgent's `KeepAlive` asks for — it records the restart and waits for something to demand the job — which left the collector down until it was started by hand. Each collector now starts a small guard process beside it that, once the collector's process has ended, waits out the LaunchAgent's throttle interval and asks launchd to start the job again unless it is already running, ended with a clean exit (such as a collector parked for re-pairing), or was stopped with `omnesis service stop`. Linux is unaffected: systemd restarts a failed collector unit on its own.
