---
"omnesis": patch
---

The browser extension's version on the gateway now follows an update. `omnesis devices list`, the portal's Devices page and `omnesis doctor` used to keep showing the version a browser was paired with, so an extension Chrome had updated, or an unpacked build reloaded, read as behind until it was paired again. The extension now reports its version with its page uploads and its periodic check, and the gateway records it when it changes, within about fifteen minutes and without a re-pair. An older extension keeps working and keeps its paired version.
