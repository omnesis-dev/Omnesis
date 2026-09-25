# Install and update lane

`.github/workflows/install-e2e.yml` installs Omnesis on real GitHub-hosted
machines, updates it, and rolls it back, with the daemons running under each
operating system's own service supervisor. Unit and E2E suites exercise the
installer and `omnesis update` against fakes; this lane is the one place that
runs `install.sh` end to end the way a user does, on a machine nobody has
prepared for it.

## What it covers

| Lane | Runner(s)                                        | Runs on                                                                              | What it proves                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | `ubuntu-22.04`                                   | pull requests and pushes to `main` that touch the installer, updater or service code | The candidate installs as release vN under systemd user units. Re-running `install.sh` hands off to `omnesis update` and lands vN+1: both daemons restarted, same collector device, same documents, a known document-search hit, a pre-update backup, no new `omnesis doctor` failures. A vN+2 whose gateway exits at boot fails, rolls back to vN+1 and serves it again. |
| S2   | `macos-15`                                       | same as S1                                                                           | The same sequence under launchd in the login session, with the macOS Keychain holding the root key.                                                                                                                                                                                                                                                                       |
| T1   | `ubuntu-24.04` gateway, `macos-15` collector     | nightly, manual dispatch                                                             | A fresh install on a tailnet with HTTPS certificates takes the Tailscale certificate branch; `curl` verifies it from the Mac without `-k`. The Mac runs the `--collector` line the gateway's installer printed and pairs over the MagicDNS name. The gateway adds an Obsidian folder on the Mac, syncs it and finds a note by keyword search.                             |
| T2   | `ubuntu-24.04-arm` gateway, `macos-14` collector | nightly, manual dispatch                                                             | Both machines install the newest real release with that release's own `install.sh`, pair and sync as in T1, then `omnesis update --fleet --yes` on the gateway moves both to the candidate: the S1 checks on the gateway, every fleet device current, and on the Mac a restarted collector on the new version.                                                            |

Every lane installs without an embedding model (`install.sh --no-model`);
embedding models are not what this lane tests. The search check is the
gateway's document search (`GET /documents/search`), which matches stored
content directly; `POST /search` finds nothing without a model (#117).

## How releases are made up

The lane never publishes anything. `scripts/install-e2e/fixture.mjs` mirrors
the checkout into a bare repository and the installer is pointed at it with
`OMNESIS_REPO_URL=file://…`. By default the candidate commit is tagged with its
own manifest version, so a fresh install's "newest stable release" is exactly
the code under test. A later release is one commit on top that moves every
lockstep `package.json` to the next version and is tagged `vX.Y.Z`; the code is
otherwise identical, unless `--break gateway-boot` makes the gateway exit
before it starts serving. T2 keeps the real release tags and publishes the
candidate as the next version.

## Running it

Single-host lanes run on any pull request that touches the paths listed in the
workflow, including pull requests from forks: they need no secrets. To run
every lane on `main` by hand:

```sh
gh workflow run install-e2e.yml --ref main -f lanes=all   # or single-host, tailnet
```

The scripts install into `$HOME` and register real user services, so they
refuse to run outside CI. Their logic has unit tests beside them
(`scripts/install-e2e/*.test.mjs`).

A tailnet lane's two jobs find each other by node names that include the run
attempt, so re-run both jobs of a failed lane ("Re-run all jobs"), not only
the one that failed.

## Release gate

`npm run release -- tag` reads this workflow's completed runs on `main` and
refuses the tag when the newest full run (the nightly schedule, or a dispatch
with `lanes=all`) is red, or when a push run newer than it is red. A cancelled
run is passed over for the one before it. With no full run yet the tag
proceeds with a warning; runs that cannot be read refuse it. After a fix on
`main`, `gh workflow run install-e2e.yml --ref main -f lanes=all` produces the
evidence that clears it. `--allow-failed-install-e2e` releases anyway, for an
emergency, and prints the failing run it overrode.

## Why the tailnet lanes never run on pull requests

T1 and T2 join a tailnet reserved for CI. The job authenticates with workload
identity federation: GitHub issues it a short-lived OIDC token, and the tailnet
trusts only tokens for this repository's `tailnet-e2e` environment, which admits
only `main` and `v*` tags. Code from a pull request, a fork or any other branch
never reaches that environment, so it never gets a tailnet node. The nodes are
tagged, ephemeral and named per run (`omnesis-ci-gw-…`, `omnesis-ci-col-…`),
and the tailnet's policy lets them reach only each other. When the
environment's credential is absent the tailnet jobs skip with a notice.

The two jobs coordinate through a small HTTP mailbox the gateway job serves on
its tailnet address (`scripts/install-e2e/mailbox.mjs`): the join URL, the
certificate fingerprint, a pairing code, phase markers, and an `abort` key
either side posts when it fails, so the other stops waiting at once. Every
wait is time-boxed.

## Public logs

Actions logs and artifacts of this repository are public. The lane never
prints `tailscale status`, a pairing code, a token or a configuration
directory. Values it learns at run time — the tailnet's DNS suffix and
addresses, pairing codes, the probe token — are registered with
`::add-mask::`, and every diagnostic passes through
`scripts/install-e2e/redact.mjs` before it is printed.
