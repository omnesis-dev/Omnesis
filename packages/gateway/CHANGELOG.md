# @omnesis/gateway

## 0.8.1

### Patch Changes

- @omnesis/agent@0.8.1
  - @omnesis/cloud-relay@0.8.1
  - @omnesis/config@0.8.1
  - @omnesis/core@0.8.1
  - @omnesis/near-dupes@0.8.1
  - @omnesis/provider-web@0.8.1
  - @omnesis/source-sdk@0.8.1
  - @omnesis/types@0.8.1
  - @omnesis/watch@0.8.1

## 0.8.0

### Patch Changes

- 8ce8f47: When Anthropic model discovery fails before any model list has loaded, the gateway retries after 15 seconds, doubling the delay up to the hourly refresh, instead of waiting a full hour. Until a list loads, a model newer than the bundled list has no known limits and the agent caps its output at 4,096 tokens, which can stop answers before they finish.
- 583aa23: The per-source index stats the status page shows are computed from a covering index on `chunks` instead of a scan of every chunk row, so refreshing them after an indexing cycle no longer holds the indexer worker (and the query embeds it answers) for minutes on a large index. The index is built once when an existing index database is opened; the gateway logs the build.
- eb3b159: Keyword search with a source, type or date filter is ranked by the in-memory index with the filter applied while scoring, instead of ranking unfiltered, joining ever wider windows to `chunks` and finally scoring every match in SQLite. Results are unchanged; a filtered search on a large index takes milliseconds in the keyword stage instead of seconds to minutes. A change to a chunk's source, type or date now reaches the in-memory index.
- 0ef2668: The gateway no longer recomputes every person's document and alias counts in one read at boot. On a large people graph that read held the only io worker for minutes, and every user read queued behind it, search's readability check among them, waited for it. The periodic sweep refreshes the counts in bounded chunks, and runs on a first boot too.
- 324ad9a: A search whose query embedding fails (for example, an embed that times out while the indexer worker is busy) now answers off keywords alone and names the failure as the vector stage's skip reason, instead of failing with an internal error. The next search embeds again.
- 03f1165: A source's stats (count, size, units, date range on the sources page) are refreshed by a scan of all its documents. A source that is always ingesting was scanned on every refresh tick and the result discarded each time because the source had changed meanwhile, so a large busy source held a read worker for minutes out of every few minutes and never got fresh numbers. A raced scan is now committed with the count reconciled from the writes that landed during it, and a source waits out a cooldown proportional to its last scan before it is scanned again.
- ed09a89: Measure source storage independently from database allocation details, retain usable results when one measurement fails, and keep accounting off the active indexer. Clarify Brain run logs and chat history in the storage breakdown.
- 85d3cec: Add manual background cleanup of Brain run logs, chat history and old backups from Settings → Storage, with persisted progress, cancellation and protection for active conversations and the newest backup.

  Expose storage measurements, limits, source trimming, rolling retention and history/backup cleanup through `omnesis storage`, including JSON output, job progress, waiting and cancellation of history cleanup. Job lookups read durable progress by ID without scanning recent job lists or the source inventory.

- a46abbd: Keep semantic search startup from repeatedly pausing after a long native graph check. Completed graph checks now process queued capacity updates before checking the storage lease; blocked or unverified capacity continues to pause growth.
- 338deb4: Avoid an unused full page walk of the main database during storage measurement. Main storage totals continue to use file sizes and document payloads, while search-index page attribution supplies lexical-index sizes independently.
- Updated dependencies [884a6de]
- Updated dependencies [ece9a88]
  - @omnesis/source-sdk@0.8.0
  - @omnesis/agent@0.8.0
  - @omnesis/cloud-relay@0.8.0
  - @omnesis/config@0.8.0
  - @omnesis/core@0.8.0
  - @omnesis/near-dupes@0.8.0
  - @omnesis/provider-web@0.8.0
  - @omnesis/types@0.8.0
  - @omnesis/watch@0.8.0

## 0.7.8

### Patch Changes

- @omnesis/agent@0.7.8
  - @omnesis/config@0.7.8
  - @omnesis/core@0.7.8
  - @omnesis/near-dupes@0.7.8
  - @omnesis/provider-web@0.7.8
  - @omnesis/source-sdk@0.7.8
  - @omnesis/types@0.7.8
  - @omnesis/watch@0.7.8

## 0.7.7

### Patch Changes

- 55df1c9: Each of the gateway's worker threads starts with less loaded. The date recognizer, the language detector, the phone-number metadata, the HTML converter, the mDNS browser and the Anthropic SDK now load the first time a thread uses them, not with every worker. On an empty install an io worker holds about 120 MB instead of 220 MB and a cpu worker about 60 MB instead of 165 MB. A gateway on a 7 GB machine starts with about 600 MB less resident.
- Updated dependencies [55df1c9]
  - @omnesis/core@0.7.7
  - @omnesis/agent@0.7.7
  - @omnesis/config@0.7.7
  - @omnesis/near-dupes@0.7.7
  - @omnesis/provider-web@0.7.7
  - @omnesis/source-sdk@0.7.7
  - @omnesis/types@0.7.7
  - @omnesis/watch@0.7.7

## 0.7.6

### Patch Changes

- The gateway now sizes its io, search and cpu worker pools to its memory budget: `gateway.memoryLimitMb`, else a container's memory limit, else the machine's memory. So a gateway with less than 16 GB, including a Docker gateway capped below 16 GB on a bigger host, starts fewer workers and stays responsive. An empty gateway used to reach about 3.5 GiB, and on a small machine without swap it could stall for seconds at a time and take minutes to answer. With a 7 GB budget the pools now start 2, 1 and 1 workers instead of 6, 3 and 2. Budgets of 16 GB or more keep the previous sizes, and an explicit `gateway.ioConcurrency`, `gateway.searchWorker.concurrency` or `gateway.cpuConcurrency` still wins.
- Updated dependencies [e0f83b3]
- Updated dependencies
  - @omnesis/core@0.7.6
  - @omnesis/config@0.7.6
  - @omnesis/agent@0.7.6
  - @omnesis/near-dupes@0.7.6
  - @omnesis/provider-web@0.7.6
  - @omnesis/source-sdk@0.7.6
  - @omnesis/types@0.7.6
  - @omnesis/watch@0.7.6

## 0.7.5

### Patch Changes

- @omnesis/agent@0.7.5
  - @omnesis/config@0.7.5
  - @omnesis/core@0.7.5
  - @omnesis/near-dupes@0.7.5
  - @omnesis/provider-web@0.7.5
  - @omnesis/source-sdk@0.7.5
  - @omnesis/types@0.7.5
  - @omnesis/watch@0.7.5

## 0.7.4

### Patch Changes

- @omnesis/agent@0.7.4
  - @omnesis/config@0.7.4
  - @omnesis/core@0.7.4
  - @omnesis/near-dupes@0.7.4
  - @omnesis/provider-web@0.7.4
  - @omnesis/source-sdk@0.7.4
  - @omnesis/types@0.7.4
  - @omnesis/watch@0.7.4

## 0.7.3

### Patch Changes

- @omnesis/agent@0.7.3
  - @omnesis/config@0.7.3
  - @omnesis/core@0.7.3
  - @omnesis/near-dupes@0.7.3
  - @omnesis/provider-web@0.7.3
  - @omnesis/source-sdk@0.7.3
  - @omnesis/types@0.7.3
  - @omnesis/watch@0.7.3

## 0.7.2

### Patch Changes

- @omnesis/agent@0.7.2
  - @omnesis/config@0.7.2
  - @omnesis/core@0.7.2
  - @omnesis/near-dupes@0.7.2
  - @omnesis/provider-web@0.7.2
  - @omnesis/source-sdk@0.7.2
  - @omnesis/types@0.7.2
  - @omnesis/watch@0.7.2

## 0.7.1

### Patch Changes

- @omnesis/agent@0.7.1
  - @omnesis/config@0.7.1
  - @omnesis/core@0.7.1
  - @omnesis/near-dupes@0.7.1
  - @omnesis/provider-web@0.7.1
  - @omnesis/source-sdk@0.7.1
  - @omnesis/types@0.7.1
  - @omnesis/watch@0.7.1

## 0.7.0

### Patch Changes

- @omnesis/agent@0.7.0
  - @omnesis/config@0.7.0
  - @omnesis/core@0.7.0
  - @omnesis/near-dupes@0.7.0
  - @omnesis/provider-web@0.7.0
  - @omnesis/source-sdk@0.7.0
  - @omnesis/types@0.7.0
  - @omnesis/watch@0.7.0

## 0.6.0

### Patch Changes

- @omnesis/agent@0.6.0
- @omnesis/config@0.6.0
- @omnesis/core@0.6.0
- @omnesis/near-dupes@0.6.0
- @omnesis/provider-web@0.6.0
- @omnesis/source-sdk@0.6.0
- @omnesis/types@0.6.0
- @omnesis/watch@0.6.0

## 0.5.14

### Patch Changes

- @omnesis/agent@0.5.14
- @omnesis/config@0.5.14
- @omnesis/core@0.5.14
- @omnesis/near-dupes@0.5.14
- @omnesis/provider-web@0.5.14
- @omnesis/source-sdk@0.5.14
- @omnesis/types@0.5.14
- @omnesis/watch@0.5.14

## 0.5.13

### Patch Changes

- @omnesis/agent@0.5.13
- @omnesis/config@0.5.13
- @omnesis/core@0.5.13
- @omnesis/near-dupes@0.5.13
- @omnesis/provider-web@0.5.13
- @omnesis/source-sdk@0.5.13
- @omnesis/types@0.5.13
- @omnesis/watch@0.5.13

## 0.5.12

### Patch Changes

- @omnesis/agent@0.5.12
- @omnesis/config@0.5.12
- @omnesis/core@0.5.12
- @omnesis/near-dupes@0.5.12
- @omnesis/provider-web@0.5.12
- @omnesis/source-sdk@0.5.12
- @omnesis/types@0.5.12
- @omnesis/watch@0.5.12

## 0.5.11

### Patch Changes

- @omnesis/agent@0.5.11
- @omnesis/config@0.5.11
- @omnesis/core@0.5.11
- @omnesis/near-dupes@0.5.11
- @omnesis/provider-web@0.5.11
- @omnesis/source-sdk@0.5.11
- @omnesis/types@0.5.11
- @omnesis/watch@0.5.11

## 0.5.10

### Patch Changes

- @omnesis/agent@0.5.10
- @omnesis/config@0.5.10
- @omnesis/core@0.5.10
- @omnesis/near-dupes@0.5.10
- @omnesis/provider-web@0.5.10
- @omnesis/source-sdk@0.5.10
- @omnesis/types@0.5.10
- @omnesis/watch@0.5.10

## 0.5.9

### Patch Changes

- @omnesis/agent@0.5.9
- @omnesis/config@0.5.9
- @omnesis/core@0.5.9
- @omnesis/near-dupes@0.5.9
- @omnesis/provider-web@0.5.9
- @omnesis/source-sdk@0.5.9
- @omnesis/types@0.5.9
- @omnesis/watch@0.5.9

## 0.5.8

### Patch Changes

- @omnesis/agent@0.5.8
- @omnesis/config@0.5.8
- @omnesis/core@0.5.8
- @omnesis/near-dupes@0.5.8
- @omnesis/provider-web@0.5.8
- @omnesis/source-sdk@0.5.8
- @omnesis/types@0.5.8
- @omnesis/watch@0.5.8

## 0.5.7

### Patch Changes

- @omnesis/agent@0.5.7
- @omnesis/config@0.5.7
- @omnesis/core@0.5.7
- @omnesis/near-dupes@0.5.7
- @omnesis/provider-web@0.5.7
- @omnesis/source-sdk@0.5.7
- @omnesis/types@0.5.7
- @omnesis/watch@0.5.7

## 0.5.6

### Patch Changes

- @omnesis/agent@0.5.6
- @omnesis/config@0.5.6
- @omnesis/core@0.5.6
- @omnesis/near-dupes@0.5.6
- @omnesis/provider-web@0.5.6
- @omnesis/source-sdk@0.5.6
- @omnesis/types@0.5.6
- @omnesis/watch@0.5.6

## 0.5.5

### Patch Changes

- @omnesis/agent@0.5.5
- @omnesis/config@0.5.5
- @omnesis/core@0.5.5
- @omnesis/near-dupes@0.5.5
- @omnesis/provider-web@0.5.5
- @omnesis/source-sdk@0.5.5
- @omnesis/types@0.5.5
- @omnesis/watch@0.5.5

## 0.5.4

### Patch Changes

- @omnesis/agent@0.5.4
- @omnesis/config@0.5.4
- @omnesis/core@0.5.4
- @omnesis/near-dupes@0.5.4
- @omnesis/provider-web@0.5.4
- @omnesis/source-sdk@0.5.4
- @omnesis/types@0.5.4
- @omnesis/watch@0.5.4

## 0.5.3

### Patch Changes

- @omnesis/agent@0.5.3
- @omnesis/config@0.5.3
- @omnesis/core@0.5.3
- @omnesis/near-dupes@0.5.3
- @omnesis/provider-web@0.5.3
- @omnesis/source-sdk@0.5.3
- @omnesis/types@0.5.3
- @omnesis/watch@0.5.3

## 0.5.2

### Patch Changes

- @omnesis/agent@0.5.2
- @omnesis/config@0.5.2
- @omnesis/core@0.5.2
- @omnesis/near-dupes@0.5.2
- @omnesis/provider-web@0.5.2
- @omnesis/source-sdk@0.5.2
- @omnesis/types@0.5.2
- @omnesis/watch@0.5.2

## 0.5.1

### Patch Changes

- @omnesis/agent@0.5.1
- @omnesis/config@0.5.1
- @omnesis/core@0.5.1
- @omnesis/near-dupes@0.5.1
- @omnesis/provider-web@0.5.1
- @omnesis/source-sdk@0.5.1
- @omnesis/types@0.5.1
- @omnesis/watch@0.5.1

## 0.5.0

### Patch Changes

- @omnesis/agent@0.5.0
- @omnesis/config@0.5.0
- @omnesis/core@0.5.0
- @omnesis/near-dupes@0.5.0
- @omnesis/provider-web@0.5.0
- @omnesis/source-sdk@0.5.0
- @omnesis/types@0.5.0
- @omnesis/watch@0.5.0

## 0.4.23

### Patch Changes

- @omnesis/agent@0.4.23
- @omnesis/config@0.4.23
- @omnesis/core@0.4.23
- @omnesis/near-dupes@0.4.23
- @omnesis/provider-web@0.4.23
- @omnesis/source-sdk@0.4.23
- @omnesis/types@0.4.23
- @omnesis/watch@0.4.23

## 0.4.22

### Patch Changes

- @omnesis/agent@0.4.22
- @omnesis/config@0.4.22
- @omnesis/core@0.4.22
- @omnesis/near-dupes@0.4.22
- @omnesis/provider-web@0.4.22
- @omnesis/source-sdk@0.4.22
- @omnesis/types@0.4.22
- @omnesis/watch@0.4.22

## 0.4.21

### Patch Changes

- @omnesis/agent@0.4.21
- @omnesis/config@0.4.21
- @omnesis/core@0.4.21
- @omnesis/near-dupes@0.4.21
- @omnesis/provider-web@0.4.21
- @omnesis/source-sdk@0.4.21
- @omnesis/types@0.4.21
- @omnesis/watch@0.4.21

## 0.4.20

### Patch Changes

- @omnesis/agent@0.4.20
- @omnesis/config@0.4.20
- @omnesis/core@0.4.20
- @omnesis/near-dupes@0.4.20
- @omnesis/provider-web@0.4.20
- @omnesis/source-sdk@0.4.20
- @omnesis/types@0.4.20
- @omnesis/watch@0.4.20

## 0.4.19

### Patch Changes

- @omnesis/agent@0.4.19
- @omnesis/config@0.4.19
- @omnesis/core@0.4.19
- @omnesis/near-dupes@0.4.19
- @omnesis/provider-web@0.4.19
- @omnesis/source-sdk@0.4.19
- @omnesis/types@0.4.19
- @omnesis/watch@0.4.19

## 0.4.18

### Patch Changes

- @omnesis/agent@0.4.18
- @omnesis/config@0.4.18
- @omnesis/core@0.4.18
- @omnesis/near-dupes@0.4.18
- @omnesis/provider-web@0.4.18
- @omnesis/source-sdk@0.4.18
- @omnesis/types@0.4.18
- @omnesis/watch@0.4.18

## 0.4.17

### Patch Changes

- @omnesis/agent@0.4.17
- @omnesis/config@0.4.17
- @omnesis/core@0.4.17
- @omnesis/near-dupes@0.4.17
- @omnesis/provider-web@0.4.17
- @omnesis/source-sdk@0.4.17
- @omnesis/types@0.4.17
- @omnesis/watch@0.4.17

## 0.4.16

### Patch Changes

- @omnesis/agent@0.4.16
- @omnesis/config@0.4.16
- @omnesis/core@0.4.16
- @omnesis/near-dupes@0.4.16
- @omnesis/provider-web@0.4.16
- @omnesis/source-sdk@0.4.16
- @omnesis/types@0.4.16
- @omnesis/watch@0.4.16

## 0.4.15

### Patch Changes

- @omnesis/agent@0.4.15
- @omnesis/config@0.4.15
- @omnesis/core@0.4.15
- @omnesis/near-dupes@0.4.15
- @omnesis/provider-web@0.4.15
- @omnesis/source-sdk@0.4.15
- @omnesis/types@0.4.15
- @omnesis/watch@0.4.15

## 0.4.14

### Patch Changes

- @omnesis/agent@0.4.14
- @omnesis/config@0.4.14
- @omnesis/core@0.4.14
- @omnesis/near-dupes@0.4.14
- @omnesis/provider-web@0.4.14
- @omnesis/source-sdk@0.4.14
- @omnesis/types@0.4.14
- @omnesis/watch@0.4.14

## 0.4.13

### Patch Changes

- @omnesis/agent@0.4.13
- @omnesis/config@0.4.13
- @omnesis/core@0.4.13
- @omnesis/near-dupes@0.4.13
- @omnesis/provider-web@0.4.13
- @omnesis/source-sdk@0.4.13
- @omnesis/types@0.4.13
- @omnesis/watch@0.4.13

## 0.4.12

### Patch Changes

- @omnesis/agent@0.4.12
- @omnesis/config@0.4.12
- @omnesis/core@0.4.12
- @omnesis/near-dupes@0.4.12
- @omnesis/provider-web@0.4.12
- @omnesis/source-sdk@0.4.12
- @omnesis/types@0.4.12
- @omnesis/watch@0.4.12

## 0.4.11

### Patch Changes

- @omnesis/agent@0.4.11
- @omnesis/config@0.4.11
- @omnesis/core@0.4.11
- @omnesis/near-dupes@0.4.11
- @omnesis/provider-web@0.4.11
- @omnesis/source-sdk@0.4.11
- @omnesis/types@0.4.11
- @omnesis/watch@0.4.11

## 0.4.10

### Patch Changes

- @omnesis/agent@0.4.10
- @omnesis/config@0.4.10
- @omnesis/core@0.4.10
- @omnesis/near-dupes@0.4.10
- @omnesis/provider-web@0.4.10
- @omnesis/source-sdk@0.4.10
- @omnesis/types@0.4.10
- @omnesis/watch@0.4.10

## 0.4.9

### Patch Changes

- @omnesis/agent@0.4.9
- @omnesis/config@0.4.9
- @omnesis/core@0.4.9
- @omnesis/near-dupes@0.4.9
- @omnesis/provider-web@0.4.9
- @omnesis/source-sdk@0.4.9
- @omnesis/types@0.4.9
- @omnesis/watch@0.4.9

## 0.4.8

### Patch Changes

- @omnesis/agent@0.4.8
- @omnesis/config@0.4.8
- @omnesis/core@0.4.8
- @omnesis/near-dupes@0.4.8
- @omnesis/provider-web@0.4.8
- @omnesis/source-sdk@0.4.8
- @omnesis/types@0.4.8
- @omnesis/watch@0.4.8

## 0.4.7

### Patch Changes

- @omnesis/agent@0.4.7
- @omnesis/config@0.4.7
- @omnesis/core@0.4.7
- @omnesis/near-dupes@0.4.7
- @omnesis/provider-web@0.4.7
- @omnesis/source-sdk@0.4.7
- @omnesis/types@0.4.7
- @omnesis/watch@0.4.7

## 0.4.6

### Patch Changes

- @omnesis/agent@0.4.6
- @omnesis/config@0.4.6
- @omnesis/core@0.4.6
- @omnesis/near-dupes@0.4.6
- @omnesis/provider-web@0.4.6
- @omnesis/source-sdk@0.4.6
- @omnesis/types@0.4.6
- @omnesis/watch@0.4.6

## 0.4.5

### Patch Changes

- @omnesis/agent@0.4.5
- @omnesis/config@0.4.5
- @omnesis/core@0.4.5
- @omnesis/near-dupes@0.4.5
- @omnesis/provider-web@0.4.5
- @omnesis/source-sdk@0.4.5
- @omnesis/types@0.4.5
- @omnesis/watch@0.4.5

## 0.4.4

### Patch Changes

- @omnesis/agent@0.4.4
- @omnesis/config@0.4.4
- @omnesis/core@0.4.4
- @omnesis/near-dupes@0.4.4
- @omnesis/provider-web@0.4.4
- @omnesis/source-sdk@0.4.4
- @omnesis/types@0.4.4
- @omnesis/watch@0.4.4

## 0.4.3

### Patch Changes

- Send the portal session CSRF token with structured configuration edits so validated settings can be saved.

- Carry self-identity source hooks into the writer and merge declarations per source type so self-authored documents resolve to the correct person across collectors.

- Harden MCP OAuth discovery, redirect validation, refresh rotation, audience aliases, and Answer ownership; preserve managed agent integrations while moving corpus access to OAuth grants; and improve authorization review and recovery across the portal and mobile apps.
  - @omnesis/agent@0.4.3
  - @omnesis/config@0.4.3
  - @omnesis/core@0.4.3
  - @omnesis/near-dupes@0.4.3
  - @omnesis/provider-web@0.4.3
  - @omnesis/source-sdk@0.4.3
  - @omnesis/types@0.4.3
  - @omnesis/watch@0.4.3

## 0.4.2

### Patch Changes

- @omnesis/agent@0.4.2
- @omnesis/config@0.4.2
- @omnesis/core@0.4.2
- @omnesis/near-dupes@0.4.2
- @omnesis/provider-web@0.4.2
- @omnesis/source-sdk@0.4.2
- @omnesis/types@0.4.2
- @omnesis/watch@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies
  - @omnesis/core@0.4.1
  - @omnesis/agent@0.4.1
  - @omnesis/config@0.4.1
  - @omnesis/near-dupes@0.4.1
  - @omnesis/provider-web@0.4.1
  - @omnesis/source-sdk@0.4.1
  - @omnesis/types@0.4.1
  - @omnesis/watch@0.4.1

## 0.4.0

### Minor Changes

- 56a13a5: Replace legacy external-agent MCP access with one OAuth-protected HTTP resource backed by principals, revisioned grants, independently revocable credentials, Portal approval, and managed OpenClaw and Hermes enrollment. Grants can independently authorize Direct and Answer over all sources, an explicit source-instance allowlist, or a denylist whose future-source behavior is shown before approval. Answer grants select a reusable named privacy-policy family with immutable edit, fork, template, and restore history, or explicitly opt into unreviewed release. Existing grants remain editable without reauthorizing the client, and code-gated authorization requests can be reviewed from a paired iPhone after a private notification.

### Patch Changes

- Updated dependencies [56a13a5]
  - @omnesis/config@0.4.0
  - @omnesis/core@0.4.0
  - @omnesis/types@0.4.0
  - @omnesis/agent@0.4.0
  - @omnesis/near-dupes@0.4.0
  - @omnesis/provider-web@0.4.0
  - @omnesis/source-sdk@0.4.0
  - @omnesis/watch@0.4.0

## 0.3.0

### Minor Changes

- b7a34a6: Add generally available gateway-hosted MCP 2026-07-28 Streamable HTTP endpoints for the privacy-reviewed Answer boundary and optional direct read access, including read-only loop retrieval; make the Privacy control surface and privacy-reviewer model assignment available for interactive Answer approvals; make the 2025-11-25/2026-07-28 stdio command a compatibility bridge over those endpoints; layer ordinary OpenClaw and Hermes answers, trusted native approval routing, and task-scoped completion retrieval exclusively over the Answer MCP endpoint, with integration delivery protocol v3 enforcing the MCP-only contract; add a client-only installer mode, separate native Claude and OpenAI plugins for Answer and Direct profiles, and a canonical retrieval playbook shared by the built-in agent, Direct MCP runtime, and generated Direct skills.

### Patch Changes

- Updated dependencies [0399f47]
  - @omnesis/core@0.3.0
  - @omnesis/source-sdk@0.3.0
  - @omnesis/agent@0.3.0
  - @omnesis/config@0.3.0
  - @omnesis/near-dupes@0.3.0
  - @omnesis/provider-web@0.3.0
  - @omnesis/types@0.3.0
  - @omnesis/watch@0.3.0
