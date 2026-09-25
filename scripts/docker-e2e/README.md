# Docker security E2E

End-to-end drills for the security features that unit tests cannot honestly
cover: a fresh install being _born encrypted_, the one-way
plaintext→encrypted migration, disaster recovery from a backup plus a printed
recovery code, dedicated-user process isolation, the headless passphrase
keyring, and the crash safety of the gateway-boot migration (kill -9 caught
mid-encryption, corpus never lost) — each executed with the real CLI and a real
gateway booted from source inside a clean Linux container.

Run locally (needs Docker; ~6 GB memory bound per scenario container):

    scripts/docker-e2e/run.sh          # all scenarios
    scripts/docker-e2e/run.sh 02 05    # subset by number prefix

CI runs the suite in full validation on `main` (the reusable `docker-e2e`
workflow), never for a pull request.

Each scenario is a self-contained bash script sourcing `lib.sh` (gateway
boot/health/refusal helpers, plaintext-header probes, assertions). Containers
get no host mounts and are removed after each run; the image rebuilds from
the current checkout (the `npm ci` layer caches on the lockfile).

## The dedicated-account gateway under systemd

`systemd/` is a separate lane for `scripts/hardened-gateway.sh`, which needs
systemd itself: a dynamic user, its state directory, the passphrase credential
and the pre-start keyring step. `systemd/run.sh` builds an Ubuntu image with
systemd as its first process and a local repository of releases cut from the
current checkout, boots it privileged, and runs `systemd/scenario.sh` inside.
It needs Docker with cgroup v2 and gives the container 8 GB.

    scripts/docker-e2e/systemd/run.sh

The scenario installs the gateway from a login account whose home is closed to
other accounts, checks what the gateway runs and as whom, pairs that account's
collector with a code, interrupts an update while it builds, updates, fails an
update whose gateway will not start and watches it switch back, rolls back,
kills the gateway, starts it without its passphrase, uninstalls, and installs
again over the kept state. It builds several releases, so it takes a while.
CI runs it as the `hardened-systemd` job of the same workflow, which needs a
privileged container and so is never triggered by a pull request.
