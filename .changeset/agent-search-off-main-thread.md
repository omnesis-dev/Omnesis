---
"omnesis": patch
---

Agent searches no longer pause the gateway. The graph evidence an agent search gathers for its hits — copies, conversations and link trails — is now read on the gateway's read workers, so on a large corpus other requests, phones and collectors keep being served while it runs, and several agent searches run at once instead of one after another. Saving and pruning Cognition Steward run transcripts also no longer reopens their index for every file, which made each save and each retention pass hold the gateway for a moment.
