---
"omnesis": patch
"@omnesis/core": patch
"@omnesis/agent": patch
"@omnesis/gateway": patch
---

Each of the gateway's worker threads starts with less loaded. The date recognizer, the language detector, the phone-number metadata, the HTML converter, the mDNS browser and the Anthropic SDK now load the first time a thread uses them, not with every worker. On an empty install an io worker holds about 120 MB instead of 220 MB and a cpu worker about 60 MB instead of 165 MB. A gateway on a 7 GB machine starts with about 600 MB less resident.
