---
"omnesis": patch
---

A long-running gateway no longer starts refusing every sync page from a source that declares URL patterns, Strava among them, with "must be a supported safe regular expression" until it is restarted. The gateway checks those patterns with a WebAssembly build of RE2 whose memory is fixed at 16 MiB, and every check left a little of it behind until none was left; the dependency is now patched to free it.
