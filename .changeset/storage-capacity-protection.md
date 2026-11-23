---
"omnesis": minor
---

**Settings → Storage** shows how much space the gateway and each source take, month by month, and accepts an optional maximum gateway size. Disk protection is always on: when a disk that holds the gateway's stores reaches 95% used space, or has less than 500 MiB available, the gateway pauses syncing, indexing and other work that grows its stores until space clears a small margin; nothing is deleted, and reads and search keep working. A gateway whose disk is already above 95% used stops syncing as soon as it runs this release: free space, or raise `gateway.storage.maxDiskUsedPercent` (at most 99). Settings shows a warning while storage needs attention. Retention of old source data stays off unless you set it.
