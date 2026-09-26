# Container topology E2E

Two containers standing in for two machines, a fixture release server carrying
ordered version tags, and the **real** installer and updater driven across
both. This is the only lane where the whole deployment story — install, pair,
update, and eventually fleet update and rollback — runs unfaked.

    scripts/docker-topology/run.sh            # the whole story, then tear down
    scripts/docker-topology/run.sh --keep     # leave the containers up
    scripts/docker-topology/run.sh --keep 01  # re-run one scenario on a kept topology

The network, the containers and the directory the fixture repositories are
published to all derive from one prefix, so two runs on one machine claim the
same names. A second run's `fixtures.sh` republishes those repositories, which
replaces them out from under the first run's git daemon — its containers keep
running and every clone starts failing for a reason that has nothing to do
with the code under test. Give a concurrent run its own set:

    OMNESIS_TOPO_PREFIX=omnesis-topo-mine scripts/docker-topology/run.sh

CI runs it nightly and on demand (`topology-e2e` workflow), never per PR: a
real `npm ci` plus `npm run build` per host per release is minutes, not
seconds.

## Why it is separate from `docker-e2e`

The security lane runs each scenario _inside_ one container, driving the CLI
and a gateway straight from a mounted source tree. It cannot see the things
this epic is about, because a single container has no second machine, no
release tags to move between, and no installer in the picture at all.

Here the containers have **no Omnesis in the image**. Only the installer under
test is copied in, at `/opt/install.sh`; everything else the installer puts
there itself, from a tag it resolves off a remote — which is the behaviour
worth proving. It is copied rather than bind-mounted because a developer umask
of 077 would leave a mounted script unreadable to the container account, and
the lane would then fail for a reason that has nothing to do with the code
under test.

## The pieces

| Piece                                        | What it stands for                           |
| -------------------------------------------- | -------------------------------------------- |
| `omnesis-topo-gateway` (alias `gateway`)     | the operator's always-on machine             |
| `omnesis-topo-collector` (alias `collector`) | a second machine that only collects          |
| `omnesis-topo-git` (alias `gitsrv`)          | the release remote, over the git protocol    |
| `fixtures.sh`                                | builds that remote from the current checkout |

The gateway is addressed as `gateway` because the certificate it mints for
itself carries that name, so the collector verifies the host it dials instead
of waving the check through.

## The fixture releases

`fixtures.sh` exports the current checkout with `git archive` into a single
base commit — no history, so the repository stays small and nothing about the
developer's tree leaks in — then tags releases on top of it. Each tag bumps
every workspace manifest **and** the lockfile through npm itself, because the
installer refuses a tag whose CLI manifest disagrees with the tag name and
`npm ci` refuses a lockfile that disagrees with the manifests.

| Repository           | Tags                               | Used by                         |
| -------------------- | ---------------------------------- | ------------------------------- |
| `omnesis.git`        | `v9.9.0`, `v9.9.1`, `v9.9.2`       | install, pairing, update, fleet |
| `omnesis-broken.git` | `v9.9.0` … `v9.9.2`, plus `v9.9.3` | a release that cannot build     |

Three good tags because the lane needs two forward moves: `v9.9.1` for the
per-host update, and `v9.9.2` for the one the gateway drives across the fleet.
Scenario 03 therefore names its target rather than taking the newest tag.

`v9.9.3` carries a deliberate type error, so `npm run build` fails on it. It
lives in its own repository because both the installer and the updater target
the newest tag they can see, and a broken newest tag would poison every other
scenario.

## The scenarios are ordered

Unlike the security lane, these share one topology and build on each other:
01 installs the gateway, 02 pairs a collector to it, 03 updates both, 04
proves a release that cannot build is rolled back. That is deliberate. Re-installing per scenario would triple a lane that is already
minutes long, and what is worth proving is precisely that each step works on
the state the previous one left behind. 05 then drives the whole fleet from
the gateway machine. A failure stops the run and leaves the
containers up when `--keep` was passed.

| Scenario                  | Proves                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `01-gateway-install`      | the installer resolves a tag off a real remote, builds it, marks the checkout managed, and leaves a gateway that serves its own version on `/health`                                                                                                                                                                                                                                                                           |
| `02-collector-pair`       | a second machine becomes a collector from one `install.sh --collector` line — CLI, a one-shot code minted on the gateway redeemed against a fingerprint-verified certificate, a saved device token — then connects over the device socket; that code cannot be redeemed twice, and a pin the certificate does not match is refused                                                                                             |
| `03-update-across-tags`   | a newer tag appears, one `omnesis update` per host does what that host's roles need — the gateway host takes its own backup through the API first, and with no service manager in a container each host is told which daemon it must restart by hand — the running gateway keeps serving the old build until it restarts, and the updated collector comes back as the same device rather than a second row                     |
| `04-update-rollback`      | a host pointed at `omnesis-broken.git` fails its build on `v9.9.3`, the update fails loudly, the checkout returns to the commit it was serving with a clean tree, and the gateway serves the old version throughout                                                                                                                                                                                                            |
| `05-fleet-update`         | one `omnesis update --fleet` on the gateway machine updates that machine and then commands the second one over the socket it already holds — the fan-out refuses while the un-restarted gateway is still serving the previous build, the collector runs its own local update and exits for its supervisor, the device list reads it as current on the new release, and a version the remote has no tag for is refused outright |
| `06-harness-on-collector` | `install.sh --openclaw` on the collector machine connects with the CLI already there: the checkout, the launcher, the credential, the trust and the keyring directory are unchanged, nothing is built, and the running collector stays connected. A code the gateway never minted stops the connect before its sign-in, which this lane has no one to approve                                                                  |

## What it deliberately switches off

`--no-service`, `--no-model`, `--no-tls` and `--no-keyring`. A container has no
user service manager, so the supervisor paths are left to the security lane's
hardened-systemd scenario (systemd) and to manual checks (launchd); the
embedding model is a large download this lane has no use for; and the keyring and certificate provisioning are already
drilled properly by the security lane against a real keyring. What is left is
exactly this lane's subject: roles, pairing, and updates.

## Adding to it

Each workstream of the deployment epic adds its own scenario here.

The installer's `--openclaw` and `--hermes` roles are the exception. They end
in `omnesis connect`, which installs a plugin into a real OpenClaw or Hermes
and waits for a human to approve an OAuth grant in a browser — none of which a
container in this lane has. Everything up to that call is driven by
`scripts/release/install-sh-harness.test.mjs` against a fake harness and a
recording CLI; the call itself is verified by hand against a real harness.

One thing this lane cannot show is the supervised half of an update. A
container has no user service manager, so the gateway and collector are
started by hand and the updater correctly reports the restarts it may not
perform rather than performing them. The restart order itself — gateway,
then the health wait that proves its forward-only migrations finished, then
the collector — is covered by unit tests over the plan builder, and a real
systemd supervisor is exercised by the security lane's hardened-systemd
scenario.
