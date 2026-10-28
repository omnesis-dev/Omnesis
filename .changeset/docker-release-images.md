---
"omnesis": minor
---

Docker installs run published release images. `install.sh --docker` pulls `ghcr.io/omnesis-dev/omnesis-gateway` and `omnesis-collector` for the version it installs, `--combined` runs both daemons in one `omnesis-combined` container, `--gateway-only` runs a gateway for collectors on other machines, and `--docker-network host|bridge` chooses the network; host networking on Linux lets the apps find the gateway over Bonjour. The images are built for amd64 and arm64 and run as an unprivileged user. `omnesis update` on a Docker install moves every image to the same release through the `omnesis-updater` image. The repository ships the Compose files, and the install guide covers persistent storage, keeping the unlock material apart from the data, your own certificates, OAuth callbacks, Tailscale on the host, collectors on other machines and Unraid.
