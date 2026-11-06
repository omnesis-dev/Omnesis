---
"omnesis": patch
---

With the experimental Brain on, the gateway no longer freezes for several seconds once a day while the Brain looks for colliding tasks, overlapping dates and contradicting notes. That search read through the whole store on the thread every request waits on, and paired every dated note with every other one, years of history included; it now runs on a background reader, pairs only the dates near today, and resolves merged people once per search. It finds exactly the same candidates as before.
