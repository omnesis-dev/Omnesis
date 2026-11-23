---
"omnesis": minor
---

Add Omnesis Lab to Settings in the portal, iOS and Android apps. Experimental mode reveals independent toggles for Brain, Tasks and Watches; new installs start with these features off, while upgrades preserve existing use. Tasks is now one of these experimental features: a gateway that runs without `OMNESIS_EXPERIMENTAL=1` keeps its tasks but no longer offers Tasks until it is started with the flag and Tasks is turned on in Omnesis Lab, which an existing task history does automatically. Tasks can run without the Brain, and disabling Tasks removes its tools and instructions from every agent. Rename the background agent to Brain and its portal debug route to `/portal/debug/brain`, retaining old links and protocol names for compatibility.
