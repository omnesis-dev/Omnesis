---
"omnesis": patch
---

On macOS, a collector that its event-loop watchdog killed, or that crashed, now always comes back. launchd can hold back the respawn a LaunchAgent's `KeepAlive` asks for — it records the restart and waits for something to demand the job — which left the collector down until it was started by hand. The collector now leaves a request behind as it dies that asks launchd to start it again after the LaunchAgent's throttle interval; when launchd has already restarted it, the request does nothing. A clean exit, such as a collector parked for re-pairing, still stays stopped. Linux is unaffected: systemd restarts a failed collector unit on its own.
