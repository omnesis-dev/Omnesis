---
"omnesis": patch
---

The Docker installer no longer stops at a single failed read of the image registry while it chooses the newest release. A read that gets no answer, or a busy or failing one from the registry, is tried up to four times with a growing pause, and each retry says why. A refused login, a missing repository and an oversized response still stop straight away. When the reads keep failing, the final error names the last cause.
