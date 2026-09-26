---
"omnesis": patch
---

On a Mac with Homebrew's mkcert, the gateway can renew its mkcert certificate: it now looks for `mkcert` in Homebrew's bin directories when its service PATH does not include them, as on Apple Silicon, where renewal failed with "`mkcert` is not installed or not on the gateway's PATH". `omnesis tls provision` and the installer look there too.
