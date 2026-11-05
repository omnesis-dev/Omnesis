---
"omnesis": patch
---

Opening a document in the portal or the mobile apps no longer freezes the gateway for seconds on a large corpus. Listing a document's attachments read every document in the store to find the one it was asked about, and held up every other request while it did; it now looks the document up by its id directly, and finds its attachments the same way. The other routes that accept a document id or an id prefix (`omnesis` commands included) use the same lookup. Results are unchanged.
