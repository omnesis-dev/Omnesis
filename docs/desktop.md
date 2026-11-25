# Native desktop application

The macOS application is a native presentation layer over the existing gateway,
collector and HTTPS product APIs. Its managed-install profile adds account-first
setup, automatic encryption and local search-model selection. The source, npm,
Docker and mobile installation paths retain their existing defaults. Windows
and Linux native interfaces can reuse the TypeScript orchestration without
reimplementing account enrollment, installation policy or recovery in each UI.

This document records the architecture, research decisions and verification
obligations. A component's presence in the tree does not prove its complete
packaged application workflow. The sections below distinguish implemented
building blocks from integration and qualification requirements.

## Boundaries

The desktop runtime lives in `packages/cli/src/desktop/`. The native macOS shell
lives in `macos/`. Local lifecycle operations use the bundled runtime; normal
source, search, device and conversation operations use gateway HTTPS APIs.
Source-specific setup remains described by the provider registry. Native code
must render the generic source protocol rather than branch on provider names.

`profile.ts` derives an application-owned config directory, service instance
and Keychain namespace. `bootstrap.ts` journals setup through claimed,
protected and configured phases. It rejects an occupied directory without its
ownership journal, serializes bootstrap with the existing process-identity
lease, and requires encryption before writing a working configuration.
Interrupted setup resumes the same identity. An existing setup cannot silently
change its library-hosting role.

`protocol.ts` implements bounded JSON-line framing and serializes lifecycle
commands. Interactive responses and cancellation bypass that queue so a prompt
cannot deadlock the operation waiting for it. Requests and interaction
responses are validated at the boundary. Unexpected errors have content-free
responses; raw exception text and credentials must not become diagnostics.
`RuntimeBridge.swift` launches the bundled Node and compiled CLI directly,
without invoking a shell or locating a system installation.

Presentation and lifecycle authority have separate responsibilities:

| Owner                    | Responsibilities                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Native shell             | SwiftUI windows, menu bar, system dialogs, App Intents/Spotlight, opening browser flows, platform permission guidance                        |
| Portable desktop runtime | Setup journal, owned paths/processes, discovery/enrollment orchestration, persisted resource recommendations, service restart/removal policy |
| Existing gateway         | Sources, search, conversations, models, device approval, permissions, resource admission and data retention                                  |
| Existing collector       | Provider authentication and synchronization using existing scoped credentials                                                                |

A desktop process must never adopt or stop an unrelated headless instance.
The first library computer remains its home; moving that library between
computers requires a separate migration design. A second app joins the same
library while retaining its own local collection and interactive authorities.

## Encryption and ownership

`packages/core/src/secret-store.ts` resolves the OS secret store and supports
`OMNESIS_SECRET_SERVICE` as an additive namespace selector. Explicit service
options override the environment. With no selector, the existing
`dev.omnesis` identity remains unchanged. Synchronous and asynchronous readers
must resolve the same service; `KEYRING_ENV_KEYS` forwards that identity to
restricted child processes.

The managed profile derives a dedicated service from its resolved config path.
A desktop purge therefore cannot remove the headless installation's root key.
`packages/cli/src/uninstall/keyring-purge.ts` retains a custom service root by
default, because an arbitrary namespace may be shared by other directories.
Deleting an exclusively app-owned root requires the caller's ownership proof.
The full CLI uninstall sweep uses the effective namespace rather than a
hardcoded service name.

The existing encryption mechanism supplies the durable protection:

- `packages/core/src/storage-keys.ts` generates random per-store keys and wraps
  them with the installation root key using authenticated encryption.
- `packages/core/src/secure-marker.ts` binds required-encryption markers to that
  key and mirrors their state in the keyring to detect accidental deletion.
- `packages/gateway/src/storage-encryption.ts` resolves encrypted live stores
  before they open and refuses an unavailable required key.
- `packages/gateway/src/sqlite-encryption.ts` handles a plaintext store by
  checkpointing, encrypting a copy, synchronizing it and atomically replacing
  the original. A blocked checkpoint is a failure, not permission to lose WAL
  commits.
- Provider store keys belong to the collector's existing encryption contract.

Fresh desktop setup must establish the root key and both encryption-required
markers before starting an ingesting process. A locked Keychain is a recovery
state; a retry must never replace a missing key or create a plaintext fallback.
Recovery export needs a deliberate, understandable UI and must not be written
to logs. The existing CLI security wizard in `commands/secure.ts` provides the
ordering reference for backup, recovery escrow and an existing-store migration.

The current macOS secret-store adapter invokes `/usr/bin/security`; its write
API has transient process-argument exposure, explicitly reported in its status.
A direct native Keychain bridge can remove that exposure, but requires a
consistent reader/child-process access contract and cannot silently create a
second key identity.

Storage encryption and encrypted gateway transport do not conceal retrieved
material from a configured cloud model provider. Model setup must explain that
boundary without claiming that cloud inference keeps prompts on the computer.

## Accounts, discovery and transport

`discovery.ts` reuses the relay's existing desktop authorization and account
gateway list. Discovery credentials only list candidate homes; they cannot
become collection or interactive credentials. An unavailable or malformed
account directory is an error. Only a validated empty list permits first-home
setup, preventing an outage from offering to create an unintended second home.

`enrollment.ts` uses the existing `pairAccountDevice` flow and keeps interactive
and collector grants separate. Each role can be persisted independently so
cancellation during the second enrollment does not discard the first role.
Browser actions, choice prompts and comparison responses remain abort-aware.

Account discovery, Bonjour and transport selection have different trust roles:

- The account directory supplies authenticated candidates, subject to the
  gateway's own existing device approval and confirmed-sign-in rules.
- Bonjour is a proximity hint. A discovered hostname or service advertisement
  cannot mint trust, grant a token or select another account's library.
- A local address may replace a relay transport only after proving the same
  gateway identity with the existing authenticated transport. Address changes
  cannot weaken TLS or switch the selected library.
- The relay hostname is the stable address shown for phone pairing and agent
  connections. Routine setup does not require selecting an IP address.

Existing mobile and collector enrollment security must remain authoritative.
No new desktop account shortcut can bypass gateway-origin passkey confirmation,
step-up protection, comparison approval, nonce purpose or revocation. Existing
cloud-relay enrollment E2E suites are the regression reference.

## Services, updates and removal

`packages/cli/src/service/` already separates pure service definitions from
platform supervision. `units.ts` produces named LaunchAgents and systemd units;
`supervisor.ts` wraps service-manager commands through injectable runners.
`packages/core/src/service-paths.ts` is the naming contract shared with doctor.
Gateway work runs at the existing interactive service priority, while collection
uses background priority. Preserve the shutdown drain budget and restart
backoff; do not stack competing keep-alive loops.

Apple's `SMAppService` is the modern interface for app-bundled login items and
LaunchAgents on supported macOS versions. Its native adapter must surface
registration approval or disabled background items, rather than silently
replacing a headless service definition. Service registration, crash recovery,
app termination and login restart require packaged-app qualification.

Updates to the native app and bundled daemons must move together. The existing
source/npm/Docker updater in `packages/cli/src/update/` is the reference for
compatibility preflight, locking, draining and migration backup; it is not a
native app updater. A desktop updater must verify the signed replacement,
keep the prior application until replacement succeeds, and respect forward-only
database migrations. Never use a native app install as permission to run npm
update or git operations against an independent headless installation.

Removal follows explicit ownership rather than process names. Stop and
unregister only owned services, await drain and process exit, then remove
app-owned runtime/cache artifacts. Keep library data by default. A separate
confirmed erase action removes only the proven managed directory and its
exclusive Keychain namespace. Explain what happens to the library on other
computers and revoke only the app's own collection/interactive credentials.
Deleting or retaining data must be tested across interrupted removal and a
concurrent second installation.

The portable desktop removal service persists retirement outside the data root
before requesting daemon stop. It then acquires runtime, component and gateway
store leases before deleting anything. The default keeps the library and keys;
automatic login startup stays retired until an explicit reconnect. Erase binds
confirmation to the ownership journal and root inode, deletes owned data first,
then clears its exclusive Keychain namespace. Interrupted key cleanup remains
an explicit pending operation. Credential publication and transport hint writes
share the external installation lease and recheck retirement before writing.
The native bridge starts its embedded observer independently of the login
preference. The helper stays resident after a daemon exits, presents its own
application to Finder's file coordination, and preserves service across ordinary
moves. Moving that application to the user's Trash or deleting it requests
`desktop system-retire`: keep-data retirement followed by the same actual store
leases. Pending update/restore operations are quiesced without replacing their
recovery intent. Packaged Finder callbacks, service registration and final Trash
interaction still require native qualification.

## Resource defaults and remediation

The existing embedder in `packages/gateway/src/indexer/embedder.ts` runs
`node-llama-cpp` in-process and supports Apple Metal. The registry's default
selection does not itself download model weights. The desktop profile therefore
chooses a local catalog model and an explicit memory budget during creation;
the model manager performs the checked download and publishes readiness.

`recommendDesktopResources` uses catalog RAM floors and download sizes. The
recommendation is persisted once. Transient pressure must not silently change
models or vector dimensions; changing an embedder uses the existing explicit
reindex behavior. A configured cloud agent is optional and independent of
local indexing. Remote inference is enabled by the managed profile while the
existing headless default remains unchanged.

The gateway already has the needed enforcement seams:

| Seam                                           | Behavior to reuse                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `models/manager.ts`, `models/downloader.ts`    | Download progress, cancellation, startup reconciliation and concurrent capacity reservation |
| `memory-budget.ts`                             | Budget resolution, graph admission reserve and graph shedding                               |
| `storage/pressure.ts`, `storage/runtime.ts`    | Physical measurement, staleness handling, hysteresis and pausing new growth                 |
| `http/routes/storage.ts`, `storage/service.ts` | Storage status, policy, retention, trim and history-cleanup jobs                            |

Desktop remediation must use those mechanisms instead of deleting arbitrary
files or killing processes. A pressure message should name an action the user
can take and preserve existing search/read access where the backend allows it.
macOS host memory-pressure integration and full-app restart remediation need
native validation; Linux cgroup-derived evidence does not prove them.

For cloud chat, the gateway already supports API-key backend presets and a
managed Codex runtime with browser/device login. `models/agent-assignment-setup.ts`
verifies a signed-in model and assigns it atomically only if the role remains
unassigned. Desktop can expose that existing subscription flow; it does not
invent an OAuth grant for unrestricted use of the ChatGPT consumer account.
The app bundles a private npm for managed runtime installation, rather than
requiring a host npm install.

## Distribution

`scripts/desktop/` assembles prebuilt native and TypeScript inputs and provides
explicit signing/notarization hooks. `prepare-runtime.mjs` builds the compiled
`omnesis` dependency closure with `scripts/runtime/stage-runtime.mjs`, installs
production dependencies in an isolated temporary tree on the target Mac,
applies production patches and copies runtime assets. Staging requires the matching
native `OmnesisRuntimeExec` product through `--runtime-exec`; it does not label an
unguarded runtime as supporting the code-use lease protocol. Bundled Node, npm
and npx launchers enter through this adapter. Runtime smoke checks copy the
verified payload into a private temporary epoch and use that same entry point,
including for native database and bridge probes. It preserves workspace
relative paths and dependencies that npm placed beside individual workspaces.
The source checkout's manifests remain source-pointing; staging performs the
existing release transformation.

The app carries a pinned Node 24 archive with a committed official SHA-256
for each supported architecture. Archives are verified before extraction.
The native launcher stages `Resources/runtime` into a private content-addressed
cache in a separate, non-purgeable Application Support directory before starting Node. Both the window bridge and login helper use that
same immutable payload path, so moving or replacing the app cannot change code
under running workers. Cache publication verifies every listed hash, rejects
extra files and escaping links, and reserves staging capacity. Release launch
authenticates the source app against the executing shell's signing team and
bundle identity. A runtime-directory environment override is available only in
debug builds. Actual managed processes retain kernel usage leases across exec;
publication and reclamation share one lock. The authenticated preload publishes
the fixed native adapter as `process.execPath`, so SDK subprocesses reserve their
own lease before loading Node even when they inherit only standard descriptors.
Owned external interpreters also retain a lease. The native `--gc-remove` operation
refuses current, in-use and legacy epochs and retains an inode-bound retry receipt
on partial deletion; such a receipt blocks startup. Selection of retained recovery
applications and uncertain archive consumers remains conservative: bounded cleanup
and the complete native replacement flow still require integration and proof.
The private npm launcher enters the guarded cached Node. Recipients need no compiler, Git, Node or npm.
Native modules and executables must match the target macOS architecture.

`native-inventory.mjs` inventories file hashes and Mach-O architectures,
rejects escaping or dangling symlinks, and rejects non-macOS native binaries.
`assemble-app.mjs` checks the runtime's version, architecture and inventory
before creating a new app bundle. A prebuilt shell preserves its native assets,
privacy metadata and embedded background login item. Nested signing refreshes
the runtime manifest from the signed bytes before the outer app seals it;
the finished DMG receives a checksum.

The direct-download channel uses Developer ID signing, hardened runtime,
notarization and stapled tickets. Nested native code is signed individually;
Node's JIT entitlements do not apply to the whole application. The distribution
script does not publish or upload a release. Signing identity and notarization
credentials are supplied separately through the developer's local identity and
Keychain profile.

Mac App Store distribution is a separate qualification boundary. The store's
sandbox and review requirements constrain arbitrary local-file providers,
subprocesses, background components and downloaded runtimes. A notarized
Developer ID application must not be represented as automatically eligible
for the Store. Store feasibility, provider capability differences and the
project license's distribution implications require explicit qualification.

Apple references:
[SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice),
[preparing an app for distribution](https://developer.apple.com/documentation/xcode/preparing-your-app-for-distribution),
[distribution outside the Mac App Store](https://help.apple.com/xcode/mac/current/en.lproj/dev033e997ca.html),
and [notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues).
Node archive pins come from the
[official release checksums](https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt).

## Verification matrix

| Requirement                | Evidence needed                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable installation      | Unit tests for ownership, phase interruption/resume, concurrent setup, cancellation and existing-install refusal                                                 |
| Required encryption        | Isolated real gateway/collector E2E proving encryption before first ingestion, missing/locked keys refusing startup and identity retained after crash            |
| Account/transport security | Existing enrollment attack and compatibility suites plus desktop discovery/enrollment tests; same-gateway proof for LAN failover                                 |
| Native UI simplicity       | Rendered screenshots and an independent nontechnical-user review of every ordinary workflow and recovery message                                                 |
| Native lifecycle           | Packaged macOS test of service registration/approval, login restart, crash recovery, app removal and independent headless instance survival                      |
| Sources                    | Generic descriptor-driven setup including local permissions, browser authentication, cancellation and provider-specific errors                                   |
| Search/chat everywhere     | Real isolated gateway with scripted model; joined computer can collect and independently search/chat                                                             |
| Models/resources           | Recommendation, download failure/resume, no transient model switching, pressure pause/resume and safe reclamation tests                                          |
| Package closure            | Linux fixture tests for architecture/hash/symlink checks; macOS smoke with no host Node/npm/git proving native modules, compiled workers and runtime assets load |
| Updates/removal            | Signed replacement failure/rollback, pre-migration backup, compatible skew, retained-data removal and explicit owned-data erase                                  |
| Backward compatibility     | Existing headless/Docker and older mobile/collector contract tests, additive fields and advertised compatibility ranges                                          |
| Distribution               | Exact source revision, per-architecture build, nested signature verification, notarization/ticket validation and artifact checksum                               |

The packaging unit suite deliberately uses tiny invented Mach-O headers and
prebuilt fixture trees. It proves assembly invariants, not that native modules
load or that macOS accepts the packaged app. Native build success does not
prove the onboarding or service lifecycle. Each row needs evidence at its own
scope before the application can be considered complete.
