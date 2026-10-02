---
"omnesis": minor
---

The gateway reads the dates written in every document's text on every install, without experimental mode or the Brain, and the agents' time queries and **Debug → Calendar** include them. An all-numeric English date such as "10/07/2026" reads month-first when the gateway's time zone is in the United States, a US territory or the Philippines, and day-first everywhere else, including Canada, Latin America and UTC. A gateway whose time zone is UTC, as a container often is, therefore reads US-style dates day-first: set `enrichment.dates.numericDateOrder` to `month-first` or `day-first` to choose explicitly.
