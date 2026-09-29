---
"omnesis": minor
---

New Maildir source. It indexes email that a mail tool keeps on the collector's machine as a Maildir — mbsync, offlineimap or getmail, for example — without Omnesis connecting to the mail server itself, which makes it the way in for accounts whose provider allows only approved mail apps. A message stored in several folders, as Gmail's labels are, is one document tagged with every folder. Folder changes, stars and replies update it without re-reading its attachments, and deleting its last copy removes it. Drafts, spam and trash are skipped. Thunderbird accounts kept in its file-per-message (maildir) store are read too.
