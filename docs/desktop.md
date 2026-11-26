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
- Managed gateway owner identities, relay sessions and ACME account/TLS keys
  use the same scoped secret-file protection. Exclusive owner-key publication
  writes ciphertext only; session preparation keeps the final cancellation
  fence immediately before publication. Managed certificate creation passes
  an in-memory key through a fixed OS pipe to OpenSSL without a private-key
  staging file. Ordinary headless credential formats remain compatible.

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

The managed macOS launch contract uses the verified native background helper as
the daemon's sole parent. Portable controllers use a fixed native start client;
a native failure cannot fall back to detached Node. The daemon verifies its
captured scope, epoch and lifetime pipe through a fixed native signed-parent
check before admission, then announces ownership only after its runtime lease,
intent checks and private control listener are ready. That frame does not prove
gateway health, collector authentication or source permissions. Closing the
helper's lifetime pipe aborts and drains the exact owned children. Restore
startup forwards only its existing activation tuple after destructive leases
have been released. Ordinary source/Linux adapters retain their explicit launch
path. Signed packaged launch and TCC attribution need their own qualification;
this transport contract alone does not identify an FDA permission target.

An authenticated helper with a different owned runtime or installation generation
leaves setup incomplete while the data-free controller remains available for
recovery. Explicit setup, connection or update handoff can replace that binding
only after the portable lifecycle policy validates its durable update or completed
erase records and releases destructive leases. The native handoff drains the
exact verified helper before starting and checking its replacement. Ordinary
status, start and restart operations never perform an implicit rebind, and a
missing or unauthenticated helper is not evidence authorizing replacement.

The runtime code epoch and the watched installed application are separate identities.
Normal replacement follows the actual signed Main application's process ancestry;
retained rollback code preserves the prior helper's verified application object
through the existing authenticated control endpoint. An archived helper stays
metadata-only until the exact signed rebind client attaches that object. File
identity and canonical Trash resolution prevent a different copy or path alias
from becoming uninstall authority. Registration is followed by a coordinated
object/path/epoch check before the helper admits a daemon; obsolete registration
callbacks cannot alter the replacement. An explicit same-code origin repair may
recover an idle authenticated helper only after portable ownership/intent checks,
verified installed-Main provenance and kernel proof that any prior handoff client
has exited. A matching scope and epoch alone do not prove origin attachment. A retained rollback may serve recovered data
while still requiring installation of that recovered version: an enabled login
item alone does not prove the next login will run it. Signed origin handoff,
Finder replacement, Trash and login behavior still require packaged qualification.

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

Home setup requires current storage-growth admission from the gateway's existing
storage-pressure policy. A blocked, expired or unavailable measurement leaves
setup incomplete and points to Storage settings; a warning alone does not block
setup. Existing library reads remain available. Joined clients do not treat the
home library's storage measurement as evidence about their own collection volume.

The home app also checks the encrypted remote route independently of account
sign-in. Its tunnel, certificate and bounded public-route probe must be current;
an account link alone does not complete this prerequisite. Managed installations
refresh that probe periodically, while ordinary headless installations retain
their existing cadence. Expired or failed evidence leaves remote setup incomplete
without disabling local library reads. This check does not confirm that an
external assistant has connected or authorized tools.

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
Claude Code subscriptions are unavailable in the managed desktop runtime until
its filesystem and Keychain credential namespaces can be independently verified.
The registry reports the existing backend reason, and the factory refuses forced
assignments without probing the global CLI or login. Anthropic API keys remain an
explicit alternative. The dedicated Codex home remains separate from the user's CLI home.
Managed Codex discovery runs the pinned native executable directly: the npm JavaScript
wrapper uses Node execve, which discards ownership descriptors. A short discovery
process holds both the library's data-use lease and its exclusive catalog lease.
After physical exit, the runtime validates actual vendor publication against its
pre-start digest witness, preserves every public model's instructions, context and
reasoning metadata, and removes native patch/code-mode tool selectors. No account
identity metadata enters the derived catalog. Conversation workers restart with an
immutable private static catalog; file hashes, effective controls and exact selected
model membership are checked before a thread starts. Missing, changed, unknown or
unsupported metadata refuses the turn rather than selecting a fallback model.
Installer compatibility probes use a separate scratch home and a metadata-only
client that cannot supply selectable models or create conversation threads.

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
Managed Node launches include a fixed `--use-system-ca` policy so HTTPS trusts the
operating system's certificate store. The launcher strips inherited trust/preload
settings, including `NODE_USE_SYSTEM_CA`, `NODE_EXTRA_CA_CERTS`, `NODE_OPTIONS`
and OpenSSL certificate-path overrides. Gateway peer pins and SAS verification
still apply independently; ordinary headless Node launch policy is unchanged.
Only newly claimed empty managed installations receive a generation-bound v3
process-authority certificate. Existing uncertified incarnations are never upgraded
by observing process absence. Every runtime launch and updater/rollback candidate
requires sealed `processAuthorityProtocol: 3`; older unknown code and old cleanup
receipts remain retained. An explicit fresh generation can rotate its certificate
only after the matching completed erase receipt and new empty claim are verified.
Filesystem identities shared with Node and Rust use POSIX realpath, preserving
`/private/var` rather than Foundation's display aliases.

Owned external interpreters also retain a lease. The native `--gc-remove` operation
refuses current, in-use and legacy epochs and pending application-launch reservations.
It removes a runtime and its verified, privately owned full-app archive together,
under the publication and usage locks. A durable receipt binds both directory inodes
before deletion; interrupted cleanup blocks startup and can retry only those original
inodes. Unknown archive ownership remains a refusal.

The explicit `updateCleanupPreview` / `updateCleanup` bridge commands bind confirmation
to the current code inventory. Cleanup requires a ready protected library and a verified
completed update. It retains the active/current runtime, the previous verified app and
any restore activation epoch; the native adapter rechecks actual live consumers at deletion.
Recovery snapshots and personal backups are retained separately. The external private
`code-retention.json` ledger records at most sixteen fully verified automatic recovery
copies, including recovered update and library-restore attempts, before another journal can replace their
operation binding. A restore records the actual backup runtime epoch and version before
creating its protective copy; absent legacy evidence remains unknown and kept. Both
operation kinds share admission before any daemon stop. Each entry binds the profile, library root, manifest and snapshot
inode. `recoveryCopies` and `recoveryCopyPin` expose only bounded metadata and explicit
pin choices; unregistered or unavailable copies are kept rather than adopted by name.
An interrupted stage has a durable ownership marker before any payload is copied.
Empty pre-marker drafts can be removed only with nonrecursive directory removal;
nonempty uncertain stages block journal replacement.

Snapshot data reclamation remains gated on the fixed native host's actual same-PID
install ownership and reacquired DATA/publication reservations. A redundant older copy
can be reclaimed while its application runs only after a newer same-epoch copy verifies;
the last copy for an older epoch additionally requires native usage-absence proof,
including separate refusal for untracked legacy incarnations. A free old code lease
alone does not prove that a legacy subprocess has stopped.
`recoveryCopyPreview` binds a separate cleanup confirmation to the reviewed copy.
`recoveryCopyRemove` and `recoveryCopyRetry` enter the fixed native host; a durable
global reservation protects the code epoch across Node's descriptor-closing execve.
The host reestablishes code and DATA usage before taking publication EX, validates
the same live install owner, and retains those reservations through physical deletion.
`recoveryCopyCancel` clears only a planned cleanup after its known native reservation
has been released. Interrupted deletion can only retry the same original inode.
The complete signed native replacement flow still requires integration and proof.
The private npm launcher enters the guarded cached Node. Recipients need no compiler, Git, Node or npm.
Native modules and executables must match the target macOS architecture.

Desktop analytics builds its pinned DuckDB engine with `httpfs`, OpenSSL and
curl linked statically. Its source and build-tool checksums live in
`scripts/desktop/analytics-build.json`; the builder runs on the target Mac
with at most two compiler workers and keeps original dependency notices.
Staging checks the exact Node binding version, replaces only its owned native
library and omits the separate extension binaries. Three isolated Node
processes must write, reopen and update one encrypted fixture across the
upstream and desktop engines. The runtime smoke check requires DuckDB to
report a built-in, statically linked encryption module and reopens an encrypted
fixture after signing. These checks must pass for the actual artifact; source
or packaging fixture tests alone do not qualify it. Source installs, npm
packages and Docker retain their ordinary pinned extension distribution.

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
The distribution command requires Release build metadata from both the native
application and its background helper before signing or archiving anything.
Debug builds permit development runtime overrides and remain development and QA
inputs. Build the Release configuration before creating a distribution package.

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

Desktop permission-wire and managed SDK/authority producer changes select the
Darwin logic and application fixtures explicitly. This includes the scoped
permission schema/service and fixed native command builders; unrelated gateway
wire changes and global Linux validation inputs do not reserve desktop runners.

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

### Collector-only permission recovery

Source-permission observations distinguish access evidence from publication
protection. Optional `publicationGuard: "managed-v1"` comes from the actual
collecting engine using the guarded runner; the gateway never synthesizes it for
an older or ordinary headless collector. It is advertised only for declared
blocking requirements that the selected runner enforces; unknown, empty and
nonblocking declarations cannot authorize a trial. Configured sources also need
the blocking declaration on their actual registered instance. An inconclusive access check can offer a
local collection trial only with that fresh capability, and never after a known
denial. Rechecking before source creation must still confirm the capability.
A trial does not complete the permission prerequisite.

The version-one private bridge accepts `restartCollector` with empty parameters.
The owned daemon control socket binds the request to the current installation
instance and serializes it through the existing collector supervisor. The old
handle must exit before a replacement starts; the gateway and interactive client
transport stay intact in both home and joined modes. Generation, process authority,
retirement, restore/update admission, protected storage and saved pairing are
rechecked. A restrictive startup option prevents self-pairing throughout this
restart and subsequent retries in the same supervisor.

A successful reply is `{kind:"desktopCollectorRestart",status:"ready",deviceId,
permissionRecheckRequired:true}`. It requires a validated authenticated gateway
hello received over the new child's owned IPC channel and the same persisted
collector identity/credential after restart. Spawn, a prior connection's online
status and socket acknowledgement do not satisfy readiness. Failures expose only
bounded safe diagnostics. Cancellation drains the bridge operation but may follow
an already completed restart; native presentation must refresh the local source's
fresh permission evidence and must never translate this receipt into a grant.
