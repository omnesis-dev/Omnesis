---
"omnesis": patch
---

The `add_note` MCP tool now requires a UUID `id` for each capture and echoes it in the receipt as `captureId`, beside the saved note's own `id`. A retry with the same capture ID saves one note even after the connection is signed in again, and captures from separate connections stay independent. Notes saved before this change keep their IDs when retried. The tool is now marked idempotent.
