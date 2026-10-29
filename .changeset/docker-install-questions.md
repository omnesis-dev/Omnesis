---
"omnesis": patch
---

`install.sh --docker` asks which embedding model to install on a host with no Node of its own, reading the model list with the Node in the image it pulled, instead of installing the default without asking. Without a terminal, it checks for `--embedder` (or `--no-model`), `--keyring-passphrase-file` (or `--no-keyring`) and, for a collector, `--code` before it pulls anything, and names every missing flag in one message. It refuses a Docker Compose older than v2.24.0, and generating a keyring passphrase no longer prints `tr: write error: Broken pipe`.
