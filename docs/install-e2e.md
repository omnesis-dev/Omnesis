# Install and update lane

`.github/workflows/install-e2e.yml` installs Omnesis on real GitHub-hosted
machines, updates it, and rolls it back, with the daemons running under each
operating system's own service supervisor. Unit tests cover individual failure paths; the installer workflows run the
actual commands, native modules, services and updater against disposable
GitHub-hosted machines. They use invented data and never publish a release.

## What it covers

| Lane | Runner(s)                                                  | Runs on                                                                                            | What it proves                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | `ubuntu-22.04`                                             | pull requests and pushes to `main` that touch the installer, updater, service code or dependencies | The candidate installs as release vN under systemd user units. Re-running `install.sh` hands off to `omnesis update` and lands vN+1: both daemons restarted, same collector device, same documents, a known document-search hit, a pre-update backup, no new `omnesis doctor` failures. A vN+2 whose gateway exits at boot fails, rolls back to vN+1 and serves it again. |
| S2   | `macos-15`                                                 | same as S1                                                                                         | The same sequence under launchd in the login session, with the macOS Keychain holding the root key.                                                                                                                                                                                                                                                                       |
| T1   | `ubuntu-24.04` gateway, `macos-15` collector               | nightly, manual dispatch                                                                           | A fresh install on a tailnet with HTTPS certificates takes the Tailscale certificate branch; `curl` verifies it from the Mac without `-k`. The Mac runs the `--collector` line the gateway's installer printed and pairs over the MagicDNS name. The gateway adds an Obsidian folder on the Mac, syncs it and finds a note by keyword search.                             |
| T2   | `ubuntu-24.04-arm` gateway, `macos-14` collector           | nightly, manual dispatch                                                                           | Both machines install the newest real release with that release's own `install.sh`, pair and sync as in T1, then `omnesis update --fleet --yes` on the gateway moves both to the candidate: the S1 checks on the gateway, every fleet device current, and on the Mac a restarted collector on the new version.                                                            |
| T3   | `ubuntu-24.04` Docker gateway, `macos-15` native collector | nightly, manual tailnet dispatch                                                                   | A locally built gateway image pairs with the actual Mac collector over verified HTTPS. A refused pin/code, fictional vault ingestion, native collector restart and container restart must preserve device, document and encrypted-state identity. No image is published.                                                                                                  |
| U1   | `ubuntu-24.04`, `macos-15`                                 | same as S1                                                                                         | The newest release's dependencies are installed, the candidate is checked out over them and `npm ci` runs again, as that release's own updater does (`scripts/install-e2e/lockfile-upgrade.mjs`, install scripts skipped). A lockfile npm cannot reconcile over the previous tree would strand every source install on that release.                                      |

Every lane installs without an embedding model (`install.sh --no-model`);
embedding models are not what this lane tests. The search check is the
gateway's document search (`GET /documents/search`), which matches stored
content directly; `POST /search` finds nothing without a model (#117).

## Installer variants and failure recovery

`.github/workflows/installer-coverage.yml` is the read-only reusable workflow
selected by the full-validation affected planner. Relevant pull requests and
pushes run a real Apple Silicon Mac installation with `--client-only` and
`--no-service`, isolated home/configuration directories, actual foreground
processes and restart/identity checks. This lane is part of the required
full-validation verdict; a selected lane cannot silently skip.

The existing `install-e2e.yml` nightly run and its `lanes=all` manual dispatch
include the extended cases. A secret-free `lanes=coverage` dispatch runs these
cases alone:

| Journey                    | Coverage                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac installation isolation | The source CLI and foreground gateway/collector run with invented documents, without registering services or altering unrelated launchd jobs. Identity and data survive process restarts.                                                             |
| Missing Node               | On a disposable hosted Mac, quarantine the actual installer-visible Node installation, exercise dependency setup, then restore the runner's original tools.                                                                                           |
| Missing Homebrew           | Quarantine the actual installer-visible Homebrew entry points and Node candidates. Require a clean, actionable refusal, restore the tools, and prove a successful retry.                                                                              |
| macOS compatibility        | Run the isolation journey on macOS 15 and 26 Apple Silicon and macOS 15 Intel, with actual OS/architecture assertions. Dependency-removal cases run on macOS 15 Apple Silicon.                                                                        |
| Interrupted updater        | A hosted Linux installation crosses real process interruption, unavailable Git remote, and a filled bounded test filesystem. Each case must prove the intended failure boundary, preserved encrypted identity and documents, then a successful retry. |

Mac cases have at most two matrix jobs active at once. Destructive dependency
cases refuse ordinary or self-hosted machines and use an exact quarantine
journal with cleanup traps. Disk exhaustion is confined to a small owned
filesystem; it never fills the runner's root disk. Results contain phase and
assertion summaries; credentials and raw private logs are not uploaded.

To validate extended coverage on a branch before merging, dispatch the existing
install workflow with its secret-free coverage selection:

```sh
gh workflow run install-e2e.yml --ref <branch> -f lanes=coverage
```

The extended installer workflow needs no secrets and can validate a branch.
T3 retains the separate tailnet environment's existing main/release-tag trust
restriction and therefore runs after the code reaches a trusted ref:

```sh
gh workflow run install-e2e.yml --ref main -f lanes=all
```

Hosted Apple Silicon runners do not support nested virtualization. These
journeys run directly on disposable hosted machines; they do not claim macOS
VM reboot, login-session, local-network permission, or physical-machine coverage.
No scenario calls a chat/agent model. Document assertions use raw document
lookup; no-model operation is not claimed to prove semantic search.

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

The release tag preflight (`npm run release -- tag`, or
`npm run release:preflight-tag -- v<version>` on its own) reads this
workflow's completed runs on `main` after it has confirmed the tagged commit's
green `full-validation` run, and refuses the tag when the newest full run (the
nightly schedule, or a dispatch with `lanes=all`) is red, or when a push run
newer than it is red. A cancelled run is passed over for the one before it. With no full run yet the tag
proceeds with a warning; runs that cannot be read refuse it. After a fix on
`main`, `gh workflow run install-e2e.yml --ref main -f lanes=all` produces the
evidence that clears it. `--allow-failed-install-e2e` releases anyway, for an
emergency, and prints the failing run it overrode. It overrides only this
gate: a tag without a green `full-validation` run is refused regardless.

## Why the tailnet lanes never run on pull requests

T1, T2 and T3 join a tailnet reserved for CI. The job authenticates with workload
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

The two jobs of a lane rarely get runners at the same time: hosted macOS
runners can be queued for hours behind other workflows while Linux ones start
at once. So each job first waits, before it installs anything or joins the
tailnet, until its partner job is running (`scripts/install-e2e/partner.mjs`
reads the run's jobs through the Actions API), for up to four hours. A partner
that ended without ever running fails the job at once. The nightly run and a
dispatch of every lane share a concurrency group, so two full runs never
overlap.

On the Mac, the Tailscale action points the system resolver at MagicDNS
(`100.100.100.100`) whenever the tailnet has MagicDNS on. The standalone
`tailscaled` forwards public names from there to the resolvers it last read
from `/etc/resolv.conf`, and reads that file again whenever a node joins or
leaves the tailnet; by then it lists only `100.100.100.100`, so every public
lookup fails and the runner loses npm, git and its own connection to GitHub.
The collector job therefore joins with `--accept-dns=false`, puts back the
DNS settings it saved before the action ran, and pins the gateway's MagicDNS
name in `/etc/hosts`. Both sides check that they can still resolve and reach
`registry.npmjs.org` and `github.com` after joining, and the collector checks
again right before its install, so a lost network fails in about a minute.

## Public logs

Actions logs and artifacts of this repository are public. The lane never
prints `tailscale status`, a pairing code, a token or a configuration
directory. Values it learns at run time — the tailnet's DNS suffix and
addresses, pairing codes, the probe token — are registered with
`::add-mask::`, and every diagnostic passes through
`scripts/install-e2e/redact.mjs` before it is printed.
