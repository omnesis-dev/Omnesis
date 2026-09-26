---
"omnesis": patch
---

On macOS, restarting the gateway service now reaches a gateway that an earlier run of the service left behind. When such a gateway kept running, launchd's own gateway waited on its configuration directory, gave up and was restarted, over and over, while `omnesis service restart` and the restart in `omnesis update` reached only launchd's copy: the update waited ten minutes for a version that could not start and rolled back. Starting, restarting, reloading, stopping or reinstalling the gateway service now first stops a gateway that holds the service's configuration directory and was started by that service but is no longer its process. A gateway you run by hand is left alone.
