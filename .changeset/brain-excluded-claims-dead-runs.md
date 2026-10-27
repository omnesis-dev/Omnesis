---
"omnesis": patch
---

Experimental Brain: a background run can no longer add a page claim that cites a source excluded from the Brain, or change an existing claim that cites one, even when the page already cites that document, so the claim verifier never reads it. A knowledge-maintenance run that ends without settling on every one of its attempts, for example because the gateway is killed each time, no longer holds its pages out of maintenance for good: an hour after its last attempt it is marked failed and its work is retried.
