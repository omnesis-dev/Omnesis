---
"omnesis": patch
---

An OpenClaw or Hermes integration no longer has to be approved again because one token refresh was slow. When the gateway took longer to answer a refresh than the integration waited, it still rotated the refresh token, and the integration was left holding a spent one; `omnesis connect --refresh` then fell back to a new approval. The integration now repeats a refresh whose answer never arrived — a timeout, a dropped connection or a server error — once, and the gateway answers that repeat with the tokens it already issued. Concurrent refreshes from the same integration wait correspondingly longer for each other.
