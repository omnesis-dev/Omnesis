---
"omnesis": patch
---

Adding a source on a collector that has just connected no longer fails with "Source assignment changed while it was being added; retry the add". A collector now reads as online only once its connection is fully set up and it has been sent the sources it hosts, and it carries out the gateway's requests in the order they were sent, so an older list of its sources can no longer overtake a newer request or list.
