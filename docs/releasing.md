# Releasing Omnesis

Omnesis versions the `omnesis` entry package and the whole `@omnesis/*` graph
in **lockstep** — one product version across gateway, collector, CLI,
providers, and agent integrations. The version lives in every public package
manifest, is served on `GET /health`, printed by `omnesis --version`, and
tagged in git as `vX.Y.Z`.

One command drives a release: `npm run release -- <subcommand>` (§ [The
release conductor](#the-release-conductor)). It owns everything from the
changeset to the annotated tag and reads nothing outside the repository.
Pushing that tag triggers `.github/workflows/release.yml`, which publishes the
packages, the container images and the GitHub Release (§ [The tag-triggered
workflow](#the-tag-triggered-workflow)).

A release is an annotated `vX.Y.Z` tag on `main`. Both distribution channels
resolve from it: a source install checks out the tag and builds it, and a
package install resolves the matching npm dist-tag. `install.sh --method auto`
prefers the package when the registry serves it and falls back to source
otherwise, so a host with no compiler works as soon as packages are published
and keeps working before that. `omnesis update` follows whichever channel the
host was installed from, and refuses a flag belonging to the other one —
`--edge` on a package install, `--registry` or a non-default `--channel` on a
source checkout — rather than ignoring it and updating to something the caller
did not ask for. `install.sh` refuses the same channel mismatches, and also
refuses `--docker --edge`: container installs resolve released images, while an
ad-hoc commit image is published manually and pinned by its immutable `sha-*`
tag.

To run an arbitrary commit in Docker, start from a normal Docker install. A
maintainer with workflow publication permission dispatches
`.github/workflows/docker.yml` on a branch or tag at that commit with "Also
publish the built images to GHCR" enabled. Once the images exist, the host pins
the resulting tag and recreates its services:

```sh
sed -i.bak 's/^OMNESIS_IMAGE_TAG=.*/OMNESIS_IMAGE_TAG=sha-0123abc/' ~/.config/omnesis/.env
docker compose -f ~/.config/omnesis/docker-compose.yml --profile update pull
docker compose -f ~/.config/omnesis/docker-compose.yml up -d --force-recreate
```

## License

Omnesis is licensed under the GNU Affero General Public License v3.0. The
`LICENSE` file at the repo root is the canonical text, every published package
manifest declares `"license": "AGPL-3.0-or-later"`, and
`stage-packages.mjs` copies the `LICENSE` file into each staged package so the
published artifact carries it.

## The dev/publish manifest split

Repo manifests point `main`/`types`/`exports`/`bin` at `src/*.ts` and pin
workspace siblings as `"*"`. That keeps the entire dev workflow — tsx,
vitest, `tsc --build` project references, worktree symlink farms — resolving
TypeScript source directly, with no stale-`dist` traps.

Publishing flips both at **stage time**, never in the repo:

- `scripts/release/transform-manifest.mjs` — pure manifest transform:
  rewrites `main`/`types`/`exports`/`bin` from `src/*.ts` to `dist/*.js`
  (+ `types` conditions), pins each `"*"` workspace dependency to the lockstep
  version, strips `devDependencies`/`scripts`, and adds the publish-only fields
  `repository`, `engines` (`node >=24.0.0`), and `publishConfig` (npm
  `access`).
- `scripts/release/stage-packages.mjs` — copies each publishable package to
  `release/staging/<name>/` with the transformed manifest, the built `dist/`
  (compiled tests excluded), runtime assets, and the `LICENSE`. Runtime assets
  are declared per package in `EXTRA_ASSETS`: the gateway's `portal/` and the
  agent integration's OpenClaw manifest/entry plus Hermes adapter bundle. Staging
  rejects compiled modules whose TypeScript source no longer exists, preventing
  incremental-build residue from entering a release.
- `scripts/release/publish.mjs --registry <url> [--tag <dist-tag>]
[--access public|restricted] [--dry-run]` — stages and packs every package,
  then publishes the packed tarballs in dependency order (`publish-graph.mjs`).
  `--registry` is required on purpose: publishing to a local verdaccio for an
  E2E test and publishing to npmjs are the same deliberate command with no
  implicit default. `--dry-run` is the one exemption — it stops after
  `npm pack` into `release/tarballs/` and publishes nothing, which is how the
  release workflow computes its checksums.

  A registry has no transaction across packages and never replaces a
  published version, so the publisher is resumable rather than atomic. All
  staging and packing happens before the first network call. Then, per
  package: a version the registry does not have is published; a version it
  already holds with the same tarball integrity is reported as already
  published and only has the requested dist-tag applied if it points
  elsewhere; a version it holds with a different artifact stops the run
  before anything after it is published, naming both integrities. Running
  the same command again after an interruption therefore continues the
  remaining graph, and the summary distinguishes newly published, already
  published, mismatched and unattempted packages. Leaves publish first, so
  the `omnesis` entry package lands only after everything it depends on and
  an interrupted publish is invisible to `npm install omnesis@<version>`
  until every dependency is in place. Packages that depend on each other
  (`@omnesis/core` and `@omnesis/source-sdk`) publish consecutively, after
  everything outside the cycle they depend on. `--access` defaults to `restricted`
  (org-private packages visible only to npm-org members). Publishing publicly
  to npmjs requires both `--access public` and
  `OMNESIS_ALLOW_PUBLIC_NPM_PUBLISH=1` — a deliberate guard against an
  accidental public push, enforced by `publish-policy.mjs`; local-registry and
  `--dry-run` publishes are exempt.

All non-private workspace packages publish; `EXCLUDED` in
`stage-packages.mjs` is empty. The 22 synthetic provider workspaces and the
browser extension (`@omnesis/extension`) are private development inputs and
never publish. The collector discovers real providers from its runtime
dependencies and synthetic providers from development dependencies only when
synthetic mode is active.

Nothing that publishes may depend on a private workspace. Such a dependency
would name a version no registry has: staging skips the private package while
the manifest transform still rewrites its `"*"` range to the lockstep version,
and the first `npm install` fails with E404.
`scripts/release/phantom-deps.test.mjs` guards both halves — undeclared runtime
imports that root-hoisting would otherwise hide until publish, and declared
dependencies on packages that never publish.

### Chrome Web Store artifact

<!-- The store ZIP's SOURCE.txt links here by this heading's anchor
     (BUILD_INSTRUCTIONS_ANCHOR in extension/scripts/store-package-contract.mjs);
     extension/src/store-release.test.ts fails if the heading is renamed alone. -->

The browser extension is distributed independently from npm. On the exact clean
release checkout, run:

```bash
git fetch --quiet origin main
release_commit="$(git rev-parse origin/main)"
test "$(git rev-parse HEAD)" = "$release_commit"
OMNESIS_EXTENSION_RELEASE_COMMIT="$release_commit" \
  npm --prefix extension run package:store:release
npm --prefix extension run smoke:chromium
```

Resolve the release commit once, before qualification, and carry that immutable
value into packaging. `package:store:release` performs no network or shared-ref
update of its own. It requires a clean checkout at the recorded commit,
refuses to overwrite a different same-version artifact, and requires the
workspace package, MV3 manifest, and
`release-contract.json` versions to match. It creates a source-map-free ZIP in
`extension/artifacts/` with `manifest.json` at the archive root, rejects any
unexpected packaged file, and prints the ZIP's SHA-256. Record the commit,
version, and digest with the store release. The committed copy under
`extension/store/` is the source of truth for listing and privacy declarations;
reconcile it with the current Chrome Web Store dashboard wording before upload.
Use `package:store` for CI and development validation before the release commit
lands.

The archive also contains the project's AGPL license and a `SOURCE.txt` file
that identifies the exact public source commit and its build instructions.
Before uploading the archive, verify that this commit and those instructions
are accessible without repository credentials. A private or inaccessible
source repository blocks distribution of the AGPL package.

`build.mjs` and the packager write to `extension/dist/` and
`extension/artifacts/` unless `OMNESIS_EXTENSION_DIST_DIR` /
`OMNESIS_EXTENSION_ARTIFACTS_DIR` redirect them; the unit tests do so, so
running them never disturbs a loaded unpacked build. `OMNESIS_EXTENSION_TEST_BUILD=1`
produces the variant the headless browser E2E loads (a pinned extension id and
host access granted at install); the build refuses it together with a store
build, and the release test asserts the packaged manifest carries neither edit.
`smoke:chromium` opens a headed browser and waits for a human to approve Chrome's
host-permission dialog; it is a manual release step, not a CI lane.

When the brand or pairing UI changes, regenerate the committed store artwork
with `npm --prefix extension run generate:icons` and
`npm --prefix extension run generate:store-assets`. The generator records a
digest of the options page, stylesheet and icon beside the screenshot
(`extension/store/assets/inputs.sha256`), and a unit test fails when any of them
changed after the last render. Unit tests also verify the icon padding, required
screenshot/tile dimensions, archive allowlist, bundled third-party notice, and
byte reproducibility across timezone and umask changes.

Upload and store submission remain deliberate dashboard actions. Use deferred
publishing when review should finish before the release becomes public. Do not
reuse a version already uploaded to the store.

## Runtime duality

Published packages run compiled `dist/*.js` with no tsx anywhere. Any code
that spawns a sibling worker thread or subprocess must go through
`resolveWorkerEntry` / `resolveSubprocessEntry` from `@omnesis/core`
(`packages/core/src/worker-entry.ts`), which picks the `.ts`-under-tsx entry in
dev and the emitted `.js` sibling when compiled. Module-relative asset paths
(the gateway's `portal/`, `package.json` reads) must work from both `src/` and
`dist/` — both sit one level below the package root, so `..`-anchored paths
are safe.

### Compiled images

Three production-runtime targets are published per release:
`gateway-runtime` → `ghcr.io/omnesis-dev/omnesis-gateway`, `collector-runtime` →
`omnesis-collector`, and `updater` → `omnesis-updater`, the one-shot image
`omnesis update` runs in on a Docker install.
`scripts/runtime/stage-runtime.mjs` computes the transitive local workspace
closure of the packages it is given (`--package omnesis`, whose closure
already spans both daemons) and stages only transformed manifests,
compiled output, and declared runtime assets. Both daemon images contain focused
production npm dependencies plus the `omnesis` CLI on PATH, run as UID/GID
`10001:10001`, and store mutable state under `/var/lib/omnesis`; neither
contains the repository source tree, tsx, Python, a JavaScript package manager,
or a native compiler toolchain. A bind mount or tmpfs at the state path must be owned by that
UID/GID and mode 0700. The gateway image is designed to run with a read-only root
filesystem and a bounded writable `/tmp`.

Run the full image and seed-installer smoke locally with:

```bash
node scripts/docker-runtime-smoke.mjs --build
```

The smoke checks all three images for the same properties — no JavaScript
package manager, the fixed unprivileged identity, an `omnesis` on `PATH`
reporting the product version — and the updater additionally for its Docker
client. It then boots an empty gateway and a seeded one as the non-root user,
checks the portal and health endpoint, requires graceful shutdown, verifies that
each instance mints a distinct bootstrap credential, and confirms the immutable
seed was not modified.

### Seeded-state artifacts

`npm run seeded-state -- create <spec.json> <output-dir>` creates a content-
addressed SQLite state artifact from a code-owned, default-deny table registry.
It rebuilds each database rather than copying a config directory. Every
production table must be explicitly classified; credential/session/delivery/
active-claim tables are forbidden in code, credential-bearing device columns
require a safe projection, and the bootstrap device is removed so first boot
can mint a fresh credential. Seed provenance is hashed from named input files,
declared row counts are checked, and the main database `user_version` must match
the declared schema version.

The command prints the SHA-256 of `seeded-state-manifest.json`. Treat that digest
as release metadata outside the artifact itself: a colocated manifest is not an
authenticity boundary. To initialize the compiled image, mount the artifact
read-only, set `OMNESIS_SEEDED_STATE_DIR` and the externally pinned
`OMNESIS_SEEDED_STATE_MANIFEST_SHA256`, and provide a fresh state volume. The
entrypoint verifies the manifest and every database before writing, requires an
exact product-version match, rejects schemas newer than the runtime supports,
and records an idempotence marker. Existing, partial, or concurrently initialized
state fails closed; discard it and start with a fresh volume.

Artifacts are mode 0444 in a traversable 0755 directory so UID 10001 can consume
them read-only. They are distribution artifacts, not backups: specs must contain
only intentionally distributable fictional data. Never use the backup service
or a whole Omnesis config directory as seed input.

## The release conductor

```
npm run release -- plan [x.y.z]     what a release would do to the tree as it stands
npm run release -- version <x.y.z>  apply pending changesets and write x.y.z everywhere
npm run release -- pr               open or refresh the release pull request
npm run release -- tag [x.y.z]      preflight, then create the annotated tag
npm run release -- status           current tag, npm dist-tags, image tags, store versions
```

Every subcommand takes `--dry-run` and every subcommand is re-runnable: each
inspects the tree, does only what is still missing, and says so when there is
nothing left. `plan` is a report and always exits 0 — the blockers it lists are
its answer; `version` and `tag` are the commands that refuse.

**`plan`** resolves the target version the way changesets will (the strongest
pending bump, or the version you name) and prints each step as done, to do,
blocked, or external, with the reason. The tag step names every unmet
precondition at once — a dirty tree, pending changesets, a tag that already
exists on origin — rather than failing on one at a time.

**`version <x.y.z>`** runs `changeset version`, synchronizes the plugin,
extension and contract manifests, refreshes the lockfile with
`npm install --package-lock-only`, writes the version into the four native
project files, and reruns the lockstep guard. It refuses when no pending
changeset could produce the version you asked for, and it refuses when the
changesets produce a different one — naming the version they do produce. The
native files are `ios/project.yml` (`MARKETING_VERSION`), both iOS Info plists
(`CFBundleShortVersionString`) and `android/app/build.gradle.kts`
(`versionName`). Their build counters — `CURRENT_PROJECT_VERSION`,
`CFBundleVersion`, `versionCode` — are deliberately untouched: they advance per
store upload, independently of the product version.

The lockfile is refreshed with `--package-lock-only` rather than a full
`npm install`, so versioning never rebuilds `node_modules` — which would be slow
in CI and destructive in a worktree that shares its dependency tree.

**`pr`** opens the release pull request with the `packages/cli/CHANGELOG.md`
section for this version as its body, or refreshes the body of the PR that
already exists for the branch.

**`tag`** runs the existing preflight — fetch origin, require a clean tree at
exactly `origin/main`, rerun the version guard, refuse an existing local or
remote tag, and refuse a commit with no green `full-validation` run from a push
to `main` or a manual dispatch (the local enforcement of step 7 below: an
unvalidated commit would fail release verification and burn the version
number; a run a later push cancelled is restarted with
`gh workflow run full-validation.yml --ref main`) — and then creates the annotated tag on the verified commit. Pass
`--sign` to sign it with your configured release key. **It never pushes.** The
push is what arms every downstream publication, so it stays one deliberate,
separately typed command:

```sh
git push origin v<version>     # never `git push --tags`
```

**`status`** prints the checked-in product version, the newest tag reachable
from HEAD, the npm dist-tags for `omnesis`, the published image tags, and a
slot for the mobile store versions. Each remote
probe fails soft and says "unavailable" rather than erroring: an unpublished
package and an unreachable registry are both answers.

### The boundary

Everything operating on public code and public channels lives in this
repository. Steps that need private credentials or private listing assets —
mobile and browser-extension store submission — do not, and the conductor never
performs them: it names store submission as the next step and stops. A wrapper
that does own those credentials calls these documented subcommands and never
reaches into their internals; `status` accepts the store versions such a wrapper
knows through `--store-versions '{"ios":"…","android":"…"}'` (or
`OMNESIS_RELEASE_STORE_VERSIONS`). The conductor never assumes such a wrapper
exists, and reads nothing outside the repository.

Cutting the tag stays a human decision.

## Cutting a release

1. Branch off `main`. The release commit lands through a pull request, and
   `pr` refuses to run from `main`.
2. `npx changeset` — describe the change, pick the bump. The `omnesis` entry
   package and all `@omnesis/*` packages are fixed together
   (`.changeset/config.json`).
3. `npm run release -- plan` — confirm the target version and that nothing is
   blocked.
4. `npm run release -- version <x.y.z>` — every manifest, the lockfile, the
   plugin and extension manifests, the native project files, and the lockstep
   guard.
5. `npm run build && npm run typecheck && npm test` — full validation.
6. Commit, then `npm run release -- pr`.
7. Merge the release commit to `main` and wait for its main-branch CI verdict.
8. On that exact checkout, `npm run release -- tag` — preflight, then the
   annotated tag on the verified commit.
9. `git push origin v<version>` — this is the act that publishes.

To sign the tag, pass `--sign` and configure the release key in git
(`gpg.format=ssh`, `user.signingkey`), then verify it against the release
allowlist:

```sh
git -c gpg.format=ssh \
  -c gpg.ssh.allowedSignersFile=/secure/path/release-allowed-signers \
  verify-tag v<version>
```

## The tag-triggered workflow

`.github/workflows/release.yml` fires on a pushed `v*` tag (and on manual
dispatch against an existing tag). In order:

- **verify** — the tag equals the checked-in product version
  (`check-product-version.mjs`), the tagged commit is an ancestor of `main`, a
  `full-validation` run started by a push or a manual dispatch succeeded at that
  exact commit (`ci-verdict.mjs` over the workflow's runs; a pull-request run or
  a later descendant cannot bless the tag), and `website/install.sh` still
  mirrors `scripts/install.sh` byte for byte.
- **packages** — build, then the local-registry round trip: publish the staged
  graph to a throwaway Verdaccio, install it through
  `install.sh --method package`, and check the installed `--version` against the
  tag. Then publish either to the configured registry or, by default, to npmjs
  with provenance. The round trip runs whether or not publication is armed; it
  is the check that the staged graph installs and runs.
- **images** — version-tagged multi-arch `omnesis-gateway` and
  `omnesis-collector` images, built every run and pushed when armed.
- **github-release** — the release notes are the changelog section the release
  commit generated, plus the SHA-256 of every tarball and of `install.sh`. The
  installer and that checksum list are attached to the release, so the script
  served at `https://omnesis.dev/install.sh` has a copy pinned to this version;
  the tarballs stay a workflow artifact, since npm is where they are installed
  from.

Each job needs the ones before it, so a publication that stops partway
leaves no release page and no images for that version: the registry holds
the packages that landed and nothing else advertises the version. Because the
publisher orders the graph leaves-first, the `omnesis` entry package lands
only after everything it depends on, and an install of that version fails to
resolve until it does.
To finish an interrupted publication, dispatch the release workflow again
against the same tag (`gh workflow run release.yml -f tag=v<version>`): the
publisher skips every package the registry already holds byte for byte,
publishes the rest, and refuses to continue past a version whose registry
artifact differs from the one this tree stages.

**Publication is armed separately from the trigger.** Until the repository
variable `OMNESIS_RELEASE_PUBLISH` is set to `1`, every distribution step runs in
dry-run: packages are packed rather than published, images are built rather than
pushed, and the release notes are printed rather than posted. A pushed tag on an
unarmed repository therefore proves the whole pipeline and distributes nothing.
The package destination is a separate choice, not another arming switch. With
`OMNESIS_RELEASE_REGISTRY` unset, the packages step uses npmjs,
`secrets.NPM_TOKEN`, provenance, and the explicit public-publish override. Set
the repository variable to an HTTPS npm-compatible registry URL (loopback HTTP
is also accepted) to use that URL for publication instead; that host receives only
`secrets.OMNESIS_RELEASE_REGISTRY_TOKEN`, which must be nonempty, while the npmjs
credential and override are never exposed to it. In both cases, publication
still requires the exact `OMNESIS_RELEASE_PUBLISH=1`. That switch arms the whole
release, including images and the GitHub Release; a package-only registry
rehearsal must use the manual publisher below rather than arming the workflow.

## Native modules and the platform matrix

A global package install pulls the gateway, the collector and every provider, so
it pulls their native modules too. Whether a host needs a compiler depends on the
module and the platform:

| Module                                              | How it ships                                                                                                                                            | Needs a toolchain when                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `better-sqlite3`, `better-sqlite3-multiple-ciphers` | `prebuild-install` fetches a prebuilt binary from the project's GitHub releases, falling back to `node-gyp rebuild`                                     | the release has no asset for the platform/ABI, or GitHub is unreachable. **Linux musl (Alpine) has no prebuilt asset** and always compiles    |
| `@duckdb/node-api`                                  | depends on `@duckdb/node-bindings`, whose optional platform packages carry the binary (`{darwin,linux}-{arm64,x64}`)                                    | never — it does not build from source at all. There is **no musl package**, so Alpine is unsupported rather than slow                         |
| `@resvg/resvg-js`                                   | optional platform packages, including `linux-{arm64,x64}-musl`                                                                                          | never on the supported matrix                                                                                                                 |
| `sharp` (WhatsApp provider)                         | optional platform packages, including `linuxmusl-{arm64,x64}`                                                                                           | never on the supported matrix                                                                                                                 |
| `usearch`                                           | prebuilds for `darwin-arm64+x64`, `linux-arm64`, `linux-x64`, resolved by `node-gyp-build`                                                              | musl, where the glibc prebuild will not load and `node-gyp-build` falls through to a source build                                             |
| `node-llama-cpp`                                    | optional platform packages plus a `postinstall`, covering `mac-arm64-metal`, `mac-x64`, `linux-{x64,arm64,armv7l,riscv64}` and the CUDA/Vulkan variants | no bundle matches the host, in which case it builds llama.cpp with cmake                                                                      |
| `smart-whisper` (optional)                          | no prebuilds — `node-gyp rebuild` on every install                                                                                                      | always, on every platform. It is an `optionalDependency`: a host without a toolchain gets an install that skips it and no local transcription |

**Supported matrix:** macOS and Linux, `arm64` and `x64`. On glibc Linux and
macOS every required module resolves to a prebuilt binary, so a package install
needs a compiler only for the optional `smart-whisper` — and skips it, rather
than failing, when there is none. On **musl Linux (Alpine)** the package channel
is not supported at all: `@duckdb/node-api` ships no musl package and does not
build from source, so the gateway cannot run there however long you wait.
`better-sqlite3` and `usearch` additionally compile from source on musl. Windows
is unsupported.

This is documented rather than solved. Publishing our own prebuilds for the
modules that lack them is a separate piece of work; until then the honest
statement is the table above.

## Verifying a release end-to-end without npmjs

Run a throwaway local registry and drive the real flow against it. This is the
same shape `install-smoke.yml` and the release workflow use:

```bash
# A registry that accepts the product graph and proxies third-party packages.
cat > /tmp/verdaccio.yml <<'CONF'
storage: /tmp/verdaccio-storage
uplinks: { npmjs: { url: https://registry.npmjs.org/ } }
packages:
  'omnesis': { access: $all, publish: $all }
  '@omnesis/*': { access: $all, publish: $all }
  '**': { access: $all, proxy: npmjs }
CONF
npx --yes verdaccio --listen 4873 --config /tmp/verdaccio.yml &
VERDACCIO_PID=$!

# npm publish sends an Authorization header even to a registry that never
# checks one, so a token has to exist; its value is irrelevant.
npm set //localhost:4873/:_authToken local
npm run build
npm run release:publish -- --registry http://localhost:4873 --tag latest --access public

export TESTHOME=/tmp/omnesis-testhome
mkdir -p "$TESTHOME/.npm-global"
echo '//localhost:4873/:_authToken=local' > "$TESTHOME/.npmrc"
HOME="$TESTHOME" NPM_CONFIG_PREFIX="$TESTHOME/.npm-global" \
  bash scripts/install.sh --method package --client-only --no-keyring \
    --registry http://localhost:4873
"$TESTHOME/.npm-global/bin/omnesis" --version
HOME="$TESTHOME" NPM_CONFIG_PREFIX="$TESTHOME/.npm-global" \
  "$TESTHOME/.npm-global/bin/omnesis" update --yes --registry http://localhost:4873

# `npm set` above wrote into your own ~/.npmrc — take it back out.
npm config delete //localhost:4873/:_authToken
kill "$VERDACCIO_PID"
rm -rf "$TESTHOME" /tmp/verdaccio-storage /tmp/verdaccio.yml
```

This exercises the transform, staging, native-module resolution, the compiled
worker entries, the `bin` shim, and the installer's package path — the exact
artifact users get. Bump the version and republish to watch `omnesis update`
advance rather than report that it is already current. Publish only from a
checkout whose version you are willing to have in the registry:
`release:publish` publishes whatever the manifests currently say.

For a release rehearsal, keep the registry persistent rather than deleting it
after this smoke test. Publish a stable version and install it into fresh
disposable environments for all four supported combinations: macOS and glibc
Linux on both `arm64` and `x64`. Leave those installations in place, then publish
the next stable release at least a week later and update the same cohort with the
same `--registry` flag. Start with empty npm and prebuild caches, make compiler,
Python, make, and CMake unavailable or fail through sentinel executables, and
explicitly load every required native module after installation. The optional
`smart-whisper` addon is expected to be absent when it cannot compile. Record any
combination not exercised as unverified rather than inferring it from another
architecture.

Beta rehearsal uses a disposable checkout with a real prerelease version; the
normal release conductor intentionally accepts stable versions only:

```bash
npx changeset pre enter beta
npx changeset version
npm run build
npm run release:publish -- \
  --registry https://packages.example.org --tag beta --access public
```

Publish the prerelease only under `beta` and verify that `latest` still resolves
the stable version. After the later stable publish, verify the inverse too:
`beta` must still resolve the prerelease.

To publish publicly to npmjs by hand, add the explicit access flag and override
(the workflow does this for you):

```bash
OMNESIS_ALLOW_PUBLIC_NPM_PUBLISH=1 npm run release:publish -- \
  --registry https://registry.npmjs.org \
  --access public
```
