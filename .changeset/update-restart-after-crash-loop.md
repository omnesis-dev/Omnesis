---
"omnesis": patch
---

A source update on a Linux machine short of memory no longer rolls back because the gateway was killed while it built. The gateway, refused a start by the source launcher until the build is in place, is restarted by systemd every two seconds, and those starts spent the unit's start limit, so systemd could refuse the update's own restart and the update undid a build that had succeeded. `omnesis update`, `omnesis service start` and `omnesis service restart` now clear a unit's recorded failures before starting it.
