# Omnesis for Mac

The native macOS app presents your existing Omnesis library through the gateway's
HTTP API. The desktop runtime owns a separate configuration and data directory;
it does not adopt, restart, or alter a headless installation.

The supported full-feature distribution is a Developer ID signed, notarized app
inside a DMG. Mac App Store distribution additionally requires App Sandbox and a
separate audit of every provider and embedded executable. This project does not
claim Mac App Store eligibility.

## Build and test

Use Node 24 for the portable runtime and Xcode 26 plus XcodeGen for the app.
Generate the Xcode project with `cd macos && xcodegen generate`, then build the
`OmnesisDesktop` scheme. Pure lifecycle/bridge models are a separate SwiftPM
library. Its process tests use the same pinned standalone Node distribution as
the app, prepared before tests run:

```sh
node scripts/desktop/prepare-node-test-fixture.mjs --arch "$(node -p process.arch)" --out macos/.node-fixture
node scripts/desktop/prepare-codex-keychain-test-fixture.mjs --arch "$(node -p process.arch)" --out macos/.codex-keychain-fixture
swift test --package-path macos
```

UI tests use the generated Xcode project and a macOS destination. Admit builds
and tests through the host's configured native test queue when one is installed.
The native check bridge and GitHub workflow prepare the fixture automatically;
tests perform no downloads and never substitute a globally installed Node or Codex.
The Codex fixture is the integrity-checked pinned distribution. Its Keychain test
uses an invalid fixture value in a new, isolated account, verifies that no
credential file appears, and deletes only that account. It performs no real
sign-in or model request; a locked or unavailable Keychain fails the test.

The scheme also builds `OmnesisRuntimeExec`, which must be supplied when staging
the matching runtime. After the native build, assemble a complete development app
on the target Mac with:

```sh
node scripts/desktop/prepare-runtime.mjs --out /tmp/omnesis-runtime --runtime-exec macos/build/Build/Products/Debug/OmnesisRuntimeExec
node scripts/desktop/smoke-runtime.mjs --runtime /tmp/omnesis-runtime
node scripts/desktop/assemble-app.mjs --runtime /tmp/omnesis-runtime --shell-app macos/build/Build/Products/Debug/Omnesis.app --out /tmp/Omnesis.app --arch "$(node -p process.arch)" --version "$(node -p 'JSON.parse(require("fs").readFileSync("packages/core/package.json")).version')"
```

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
retained separately.
The app
refuses to launch an incomplete bundle; it never substitutes a globally installed
CLI or another checkout.

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
preferences. Optional login startup is registered through `SMAppService` in
Settings. It does not request root access. The observer keeps running after a
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
unused code. Assistant approval starts from the connecting app's comparison code
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
metadata readable. A download is reported saved only after successful completion
and synchronization to disk.

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
