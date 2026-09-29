---
"omnesis": minor
---

Gmail reads mail more faithfully. A message is dated by its `Date` header rather than by when Gmail received it, so mail imported from another account sits in the year it was sent. Bodies are decoded in the charset they declare, a "view in browser" or abridged plain-text part gives way to the HTML that carries the message, the date line no longer renders as a heading, Bcc recipients on sent mail join the people graph, automated senders no longer create people, and signature logos are no longer indexed as attachments. A first sync keeps listing the mailbox until Gmail has no more pages, so the oldest mail is no longer left unread, and a message deleted between being listed and being fetched is treated as deleted rather than as an expired history. The changes apply to mail synced after the update; mail already indexed keeps its current form until the source is resynced.

Shared attachment extraction improves for every source: legacy PowerPoint files are read from their text records instead of their raw bytes, binary noise from old Office files is no longer indexed as text, text attachments honour their declared charset, image file names in URLs are no longer taken for email addresses, and one slow OCR request no longer pauses OCR for every image after it. `inference.ocr.requestTimeoutSeconds` sets how long a collector waits for one image's OCR.
