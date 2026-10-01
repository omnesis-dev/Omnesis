---
"omnesis": patch
---

OpenClaw: when the gateway refuses an expired Omnesis access token, the plugin renews it with its refresh token again, including when the gateway's authorization server is on another address than its MCP endpoint. Previously that renewal was refused locally and every expiry fell back to re-issuing the credential with the device's management token.
