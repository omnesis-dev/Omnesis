---
"omnesis": patch
---

The iOS and Android apps reconnect to the gateway as soon as the network returns or you come back to the app, instead of waiting out a retry delay of up to 37 seconds. While reconnecting, Settings says the phone is offline or that it is retrying, and keeps the underlying error visible; it no longer reads as a failed connection or suggests pairing again because the internet dropped. Rejected credentials and certificates that fail verification are reported separately, and TLS verification and the pairing are unchanged.
