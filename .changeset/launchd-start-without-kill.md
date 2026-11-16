---
"omnesis": patch
---

On macOS, installing or reinstalling the gateway and collector services no longer fails when launchd answers "Operation not permitted" to the request that starts a service it has just registered. The installer used to end in its "start the daemons yourself" mode with the service in fact running. `omnesis service install`, `reload` and `start` now start a newly registered service without first stopping the copy launchd has already started, and treat a refused start as a failure only if the service is not running. Each service also starts about ten seconds sooner, because the copy launchd started is no longer stopped and started again.
