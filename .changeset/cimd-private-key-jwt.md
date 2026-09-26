---
"omnesis": patch
---

ChatGPT can connect to a gateway again. It identifies itself with a client metadata document that authenticates by a signed key (`private_key_jwt`) rather than as a public client, and the gateway refused every such client with "Client metadata could not be verified." The gateway now accepts these clients: it fetches the key set their metadata document names, verifies each signed client assertion at the token and revocation endpoints (signature, issuer, audience, expiry and single use), and advertises `private_key_jwt` in its authorization-server metadata. When a client's metadata cannot be verified, the gateway log now says why.
