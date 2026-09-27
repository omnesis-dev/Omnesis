---
"omnesis": patch
---

Keep headless OAuth recovery working for OpenClaw and Hermes for the whole life of an approved connection. When a harness could no longer refresh its Omnesis ticket, the gateway re-keyed the approved credential by reading the audience and scope from the original authorization request — a row the access cleanup deletes minutes after approval. From then on recovery answered as if the grant had been revoked, and the harness told the operator to run `omnesis connect <harness> --refresh` although its grant, device and credential were all valid. The approved audience and scope now live on the credential itself, and existing credentials are filled from their surviving authorization requests or tokens on upgrade. The OpenClaw plugin now logs why a refresh failed when it falls back to recovery, and names that reason in the error if recovery fails too.
