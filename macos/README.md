# Omnesis for Mac

The native macOS app presents your existing Omnesis library through the gateway's
HTTP API. The desktop runtime owns a separate configuration and data directory;
it does not adopt, restart, or alter a headless installation.

The supported full-feature distribution is a Developer ID signed, notarized app
inside a DMG. Mac App Store distribution additionally requires App Sandbox and a
separate audit of every provider and embedded executable. This project does not
claim Mac App Store eligibility.

The native visual system lives in `Sources/OmnesisDesktop/DesktopTheme.swift`;
the shared control states live in `DesktopControls.swift`. The white brand mark
is the existing website vector, cropped to its own bounds, without an app-icon
tile inside the window. Navy surfaces remain dark in both system appearances,
including native window controls. The app does not require transparency effects.
Modal content uses the same opaque canvas through a shared native sheet wrapper;
the system continues to manage titlebar and toolbar materials.
Automatic startup is a required setup step, with a separate pending-approval
state. A verified owned installation attempts registration once, recording that
attempt before contacting macOS; later revocation requires explicit repair.
Source, computer and startup status refresh while the app remains open and after
it returns to the foreground. These monitors belong to the store, so they also
run with every main window closed or during a menu-only launch. A role, API or
installation change cancels and joins the old checks before their replacements
start; a view cannot stop prerequisite monitoring by disappearing.
Failed refreshes leave setup unverified without
disabling existing library reads or treating a network failure as an OS denial.
If the background owner becomes unavailable after a library was verified, the
app preserves reads for that same installation and connection while showing
required repair. A different installation cannot inherit that read connection,
and a portable ready response cannot clear a native ownership block.
Library HTTP panels and their drafts belong to one immutable API context. Changing
that context clears cached metadata, unsaved credentials, approvals and document
selection. Retired requests are canceled and joined before successor dispatch;
a late phone code is withdrawn only through the library that issued it. A return
to the same API object creates a new context. Background-helper loss within an
already verified installation preserves the existing HTTP connection and its
approved scopes; it does not grant a new connection or native lifecycle authority.
Home setup also requires fresh storage admission and an observed remote-library
connection. Optional malformed or legacy evidence leaves these prerequisites
unverified while preserving protected local reads. A generation-bound native
timer expires the evidence using wall and monotonic clocks even if status polling
stalls; an unchanged response cannot renew its deadline. The connection repair
sheet uses the existing account status and reconnect operations, and only a
fresh coordinator projection can complete the prerequisite afterward.
A recovered app can expose an authorized recovered library before installation
is finished. Its startup row remains pending until authenticated native evidence
matches the installed app and current installation; an enabled login item alone
cannot complete this step.
The helper tracks the installed application object separately from the runtime's
immutable code epoch. Retained rollback helpers accept an origin only through the
authenticated native handoff and cannot start collection while origin is unknown.
Running a retained version while a newer app remains installed leaves an explicit
installation prerequisite; login-item enabled status alone does not clear it.
Actual signed handoff, Finder move/replacement/Trash and next-login behavior need
packaged qualification; pure metadata and owned-process tests do not prove them.
The source access coach asks only for descriptor-declared scopes. Opening System
Settings or restarting collection never grants access, and a readable source root
does not clear a retained error for an unreadable descendant.
An unverified-access trial additionally requires the selected local collector's
explicit managed publication-guard capability; a local device ID alone does not
establish it. Missing or unknown capability requires updating and rechecking.
Source forms load the selected collector's complete descriptor, rather than using
another computer's metadata from the fleet list. Missing permission declarations
remain unverified. An older gateway can forward explicit no-local-permission
metadata from a newer collector, but adding a source whose access still needs
verification requires compatible permission-check support on both ends. Existing
library reads and collection are not blocked by this onboarding limitation.
Host setup additionally requires disabling automatic system sleep while
connected to power. A bounded read of the system's AC sleep policy and current
power source verifies this condition; display sleep and screen locking remain
independent. Public power-source notifications invalidate stale readiness after
unplugging, and foreground/periodic checks detect policy changes. Unknown output
or unsupported UPS policy cannot complete setup. The reusable guide distinguishes
desktop and laptop settings and links to Apple's steps. Opening it changes no
settings and supplies no readiness evidence. Disabling idle sleep does not
override manual sleep, closing a laptop, shutdown or network loss.
Navigation and toolbar structure follow Apple's
[SwiftUI app design guidance](https://developer.apple.com/videos/play/wwdc2025/323/),
with semantic control hierarchy informed by the
[button guidelines](https://developer.apple.com/design/human-interface-guidelines/buttons).

## Build and test

Use Node 24 for the portable runtime and Xcode 26 plus XcodeGen for the app.
Generate the Xcode project with `cd macos && xcodegen generate`, then build the
`OmnesisDesktop` scheme. Pure lifecycle/bridge models are a separate SwiftPM
library. Its process tests use the same pinned standalone Node distribution as
the app, prepared before tests run:

```sh
node scripts/desktop/prepare-node-test-fixture.mjs --arch "$(node -p process.arch)" --out macos/.node-fixture
node scripts/desktop/prepare-codex-keychain-test-fixture.mjs --arch "$(node -p process.arch)" --out macos/.codex-keychain-fixture
node scripts/desktop/codex-backend-test-fixture.mjs --out macos/.codex-backend-fixture
swift test --package-path macos
```

UI tests use the generated Xcode project and a macOS destination. Admit builds
and tests through the host's configured native test queue when one is installed.
The native check bridge and GitHub workflow prepare the fixture automatically;
tests perform no downloads and never substitute a globally installed Node or Codex.
Hosted GUI integration tests mount the production SwiftUI root and press its own
accessibility controls against a scripted loopback HTTP/SSE service. This exercises
sending, streaming, completion and cancellation without model inference; it is
distinct from the external XCUITest runner and from packaged first-run qualification.
The scheme and admitted test bridge disable parallel testing: these cases share
application windows and process-local test adapters. Keychain component fixtures
restore their process-local interaction setting and remove only their own items.
Window captures use ScreenCaptureKit's current-process-only API, without requesting
Screen Recording access or capturing another application's windows.
The Codex fixture is the integrity-checked pinned distribution. Its Keychain test
runs once in the hosted GUI integration target, matching the app's Aqua security
context; pure SwiftPM tests do not mutate the user Keychain. The hosted test
uses an invalid fixture value in a new, isolated account, verifies that no
credential file appears, and deletes only that account. It performs no real
sign-in or model request; a locked or unavailable Keychain fails the test. The test
also compares vendor status, the explicit User-domain metadata query and the
security tool's selector. A successful save alone does not qualify removal or
absence checks when those views disagree.

The scheme also builds `OmnesisRuntimeExec`, which must be supplied when staging
the matching runtime. After the native build, assemble a complete development app
on the target Mac with:

```sh
node scripts/desktop/prepare-runtime.mjs --out /tmp/omnesis-runtime --cache /tmp/omnesis-runtime-build-cache --runtime-exec macos/build/Build/Products/Debug/OmnesisRuntimeExec
node scripts/desktop/smoke-runtime.mjs --runtime /tmp/omnesis-runtime
node scripts/desktop/assemble-app.mjs --runtime /tmp/omnesis-runtime --shell-app macos/build/Build/Products/Debug/Omnesis.app --out /tmp/Omnesis.app --arch "$(node -p process.arch)" --version "$(node -p 'JSON.parse(require("fs").readFileSync("packages/core/package.json")).version')"
```

The native build bridge also accepts `scripts/macos-test.sh --build-only --package`
when the configured native pool admits the build. This explicit scope installs
locked build dependencies under an isolated home, compiles the production closure,
assembles an unsigned Release app, and runs the actual bundled-runtime smoke check
before and after assembly. It also compiles the standalone QA services against
that runtime, exercises real loopback TLS, scripted model HTTP and local ACME,
and retrieves their portable raw tree with the qualification record. The tree
lives under `evidence/<attempt>/services`; its Node and native dependencies are
copied into it, so relocation does not require the build checkout. A success
record requires the services child to exit after normal shutdown. A forced stop
retains failure metadata and leaves normal service closure unverified.

The assembled app remains an ephemeral build input; the distribution workflow
owns archived applications. This check does not sign, notarize, publish, exercise
a personal account, or qualify app/helper startup and OS permissions. The default
build-only scope remains the native Release build and static analytics library
build.

The complete app bundles the compiled runtime under
`Omnesis.app/Contents/Resources/runtime/`: `node` and
`packages/cli/dist/index.js` plus its package closure. A development build can
point at that same staged layout with `OMNESIS_DESKTOP_RUNTIME_DIR` in Debug
builds only. Before launch, the native shell verifies and copies the full payload
into a separate, non-purgeable Application Support cache, keyed by the runtime manifest's hash. Both the app and
login helper run from that stable path even if Finder moves or replaces the app.
Release builds require the source app's valid signature to match the executing
shell's signing team and the desktop bundle identity. Updates offers an explicit
preview and confirmation to remove older application code. Cleanup keeps the
current and active versions, pending recovery/update versions, uncertain launch
reservations and one previous verified application. Kernel-held usage leases
prevent removing code still in use. Personal data and recovery snapshots are
retained separately. The portable runtime tracks at most sixteen verified automatic
recovery copies from application updates and library restores, preserves pin choices and refuses another update when its copy cannot
be retained. Explicit snapshot reclamation requires a separate native reservation;
application-code cleanup never deletes a personal backup.
The app
refuses to launch an incomplete bundle; it never substitutes a globally installed
CLI or another checkout.

Distribution inputs must come from the scheme's Release configuration, including
its background helper and `OmnesisRuntimeExec`. Use the Release product paths when
staging and assembling that app. The distribution script rejects Debug or
unstamped app/helper builds before signing or making a DMG; the Debug example
above is for isolated development QA.

Managed ChatGPT sign-in uses a dedicated canonical Codex home and strict macOS
Keychain credential storage. Concurrent workers share that credential namespace
while keeping separate workspaces and state directories. A legacy plaintext
credential file blocks use until explicit sign-out; logout and removal verify
absence of only this installation's Keychain account. Diagnostic vendor state
still requires its own persistence audit; ephemeral threads alone do not prove
all diagnostic files are encrypted.

The app starts `desktop bridge` over a private JSON-lines pipe. Lifecycle replies
and interaction prompts determine the real onboarding state. Gateway tokens stay
in memory, never in URLs or Preferences. A home library only becomes available
when the runtime confirms encrypted storage. Local certificates are pinned via
the shared Apple transport client.

The embedded `OmnesisBackground.app` observes the application's lifecycle and runs
`desktop daemon`. Opening the app starts this observer independently of login
preferences. Required login startup is registered through `SMAppService` once
the app confirms its owned installation. Pending approval or a disabled service
leaves setup incomplete and offers explicit repair in System Settings. It does
not request root access. The observer keeps running after a
daemon exits, preserves ordinary Finder moves, and requests keep-data retirement
when its application is trashed or deleted. Pending update/restore recovery intent
is preserved. Packaged Finder and login behavior still need native qualification.
Stopping Omnesis preserves the library. Removing data is a separate explicit operation.

Native sources use provider descriptors and the existing discovery, validation,
credentials, authorization and add endpoints. Chat shares the Apple `AgentClient`
for HTTP/SSE and conversation persistence. Source setup renders provider credential
instructions and typed sign-in forms. Per-account keys remain available for retry
until the connection succeeds. Hosted provider widgets use a separate ephemeral
browser view pinned to the library’s public certificate, with outgoing cookies
blocked. The browser receives no library administration credential; bounded
widget results return through the native authenticated API. App Intents expose a new conversation
and a question prepared in the composer; Spotlight availability depends on the
macOS version. Personal library contents are not indexed into system Spotlight.

The first-launch screen separates an existing-account discovery from the explicit
choice to create a first library. A failed discovery never offers an empty
account as though it were confirmed. Creating a first library requires the
person to confirm this is their first and choose the Mac that will stay awake.
The account form supports existing/new accounts, invitation codes and the
configured certificate authority's terms. Download progress uses the runtime's
measured byte counts; a failed model download offers an explicit retry.

Phone pairing and assistant connections use the ready Omnesis relay address
advertised and authorized by the gateway. They never fall back to a LAN address.
Phone QR payloads are built by the gateway, and closing their sheet withdraws the
unused code. The sheet lists currently connected phones without attributing them
to that code; finish and confirm the connection in the phone app. Assistant approval starts from the connecting app's comparison code
and requires an explicit source selection. Direct source reading and answers
without privacy review have separate, visible choices. A required passkey
confirmation uses the library's secure browser page; the app never bypasses it.

The native process clears inherited headless configuration, Node loader/trust
settings and inference API keys before launching Node. Its runtime environment
keeps the real user home for Keychain and prefixes the cached runtime directory.

To remove the managed installation, choose **Settings → General → Remove Omnesis
from this Mac**. Keeping the local data and encryption key is the default. Erasing
local Omnesis data requires a separate confirmation. The app asks the runtime for
an ownership-bound removal preview, unregisters its own login item, and displays
the actual outcome. An unfinished saved-key cleanup remains visible and can be
retried. After successful removal, a separate confirmation can move this verified app
copy to Trash and quit. Pending key cleanup never enables that action. You can
also keep the app and quit manually. Tests never invoke actual Trash operations.
The app never removes your original source files or another installation.

**Settings → General → Recovery protection** prepares recovery only on the Mac
that owns the library. Save the sealed recovery file and its code separately,
then explicitly confirm. Drafts expire after five minutes; cancellation leaves
existing recovery protection intact. Replacement requires its own consent and
never changes the library's encryption key. Keep older recovery codes for older
backups. Recovery protection does not make a backup of the library.

The Storage settings page refreshes the gateway's actual measurement, changes
its library size limit, and starts or cancels older-history cleanup. Cleanup
requires confirmation and always preserves the newest backup. Unknown
measurements stay unknown; cancelled or partially failed cleanup reports what
was already removed. Source history limits require a separate confirmation before automatic deletion
is enabled. Memory settings show the measured library process and save startup budgets.
Applying them requires an explicit restart on the Mac that owns the library.

Backups settings creates actual backups or JSON/CSV exports, follows generation
status, and downloads completed artifacts through authenticated streaming. Save
creates a new private file and refuses existing destinations and redirects.
Cancellation removes only the download's own partial file. Readable or mixed
contents require explicit consent; encrypted data payloads still leave archive
metadata readable. A download is reported saved only after complete TAR framing
(including the terminating blocks), successful completion and synchronization to
disk. A clean HTTP EOF without Content-Length cannot certify a truncated archive.

Recovery protection also accepts an existing recovery JSON file and its code.
The managed home must retain both modern encryption markers matching that key.
Import refuses another existing Keychain key, uses atomic create without update,
and verifies both required-encryption Keychain mirrors before reporting recovery.
A locked Keychain, foreign file or incomplete marker restoration stays a visible
failure. File contents and the entered code remain in memory and the private
runtime pipe; importing never creates a replacement root key.

General backup restore uses the selected original archive through a private file
selection descriptor. The sidecar copies it directly into encrypted staging,
authenticates the archive and recovered source keys, and issues a short-lived
one-use preview confirmation. Applying it stops only the owned runtime, reserves
all store owners, retains a protected recovery snapshot, and rebuilds trusted
stores while retaining this Mac's account, credentials for its own identity,
certificates, model connections and root key. Source credentials and user-authored
prose are rewrapped for that root. Restored sources, watches and automation stay
paused for review. Model connections remain, while every model role and automatic
personal-data deletion policy pauses until review. New backups include chat
history with inert imported sessions; older backups without the history marker
preserve existing chats. Derived summaries rebuild. No restored data or source root key is written as plaintext
staging. Legacy SQLite and analytics inputs have bounded memory-only handling.

An applied backup remains pending until a separate explicit Start verifies real
protected health, the retained administrative identity, database integrity/schema
and measured data counts, and the paused review state. Automatic startup cannot
mint that operation-bound activation. Failed verification remains fenced, with
an explicit recovery action for the previous library. Unknown schema versions
and nonempty database sidecars are refused rather than silently losing data.
The original archive remains untouched; a readable original stays readable.

Erase and restore publication run in a fixed operation subprocess under the
native exclusive data lease. Runtime consumers and descendants retain shared
data leases; control bridges do not. The controller holds the restore-session
lease until its exact operation host exits, while that host revalidates the
durable operation and owns all install and store leases during mutation.
After confirmed data erasure and authoritative Keychain absence, creating a
fresh installation is a separate confirmed action. It preserves the erase
receipt, publishes a new identity generation last, and requires a new bridge
before setup. Retained-library reinstall keeps its existing identity.

Settings → Backups also reads the private bridge's automatic recovery-copy catalog
and saves per-copy keep choices through `recoveryCopies` / `recoveryCopyPin`.
It shows retention registration time, preserved interrupted copies and unknown
older copies separately. Clearing a keep preference never deletes a copy. The portable
bridge provides a separate verified preview, explicit cleanup, exact-operation retry
and planned-cleanup cancellation. Its native host retains install, data and code
publication ownership through deletion; unknown legacy consumers cannot authorize
cleanup. Personal backup/export downloads remain separate from these local automatic
recovery copies.
The native confirmation names the selected copy and the authoritative copy that
will stay kept, shows its recorded size, and requires a separate acknowledgement.
Stopping waits for the runtime to drain, then reads the current catalog. An
unfinished removal offers only the original operation's retry; a planned removal
can be cancelled while keeping its copy. Unidentified replies never enable removal.

Permission recovery can use the portable `restartCollector` command, independently
of the whole-library restart for startup settings. Both hosted and joined Macs
restart only the exact supervised local collector, wait for its exit, then verify
the replacement's authenticated device identity against the unchanged saved
credential. This path cannot self-pair or enroll a new identity. It does not
restart the foreground app, background helper, gateway or another installation.
Its `permissionRecheckRequired` reply requires a fresh source capability probe;
collector readiness is not permission authorization. Cancellation can arrive
after collection has restarted, so the UI refreshes evidence instead of reporting
an assumed outcome. Pending lifecycle operations and uncertain ownership refuse
the action.
