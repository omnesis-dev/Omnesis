# macOS application packaging

These scripts build local artifacts. They never upload a release or submit an
App Store application. The direct-download channel uses a Developer ID signed,
notarized application and DMG; the Mac App Store requires separate sandbox and
provider-access qualification.

Build on macOS for the target architecture, using Node **24.21.0** and the
checkout's lockfile-installed development dependencies. Runtime preparation uses
an isolated production install, applies the production patches, compiles the
existing CLI/gateway/collector closure, and preserves its runtime assets and
workspace-local dependencies. It never installs into the source checkout.
Native dependency lifecycle scripts run on that Mac. No compiler, Git checkout,
host Node installation or host npm is required on the recipient's computer.

```sh
xcodegen generate --spec macos/project.yml
xcodebuild -project macos/OmnesisDesktop.xcodeproj -scheme OmnesisDesktop \
  -configuration Release -derivedDataPath /tmp/omnesis-desktop-build \
  CODE_SIGNING_ALLOWED=NO build
node scripts/desktop/prepare-runtime.mjs \
  --arch arm64 --cache /tmp/omnesis-node-downloads --out /tmp/omnesis-runtime-arm64 \
  --runtime-exec /tmp/omnesis-desktop-build/Build/Products/Release/OmnesisRuntimeExec
node scripts/desktop/assemble-app.mjs \
  --runtime /tmp/omnesis-runtime-arm64 \
  --shell-app /tmp/omnesis-desktop-build/Build/Products/Release/Omnesis.app \
  --arch arm64 --version 0.8.1 --out /tmp/Omnesis.app
```

Use the checkout's product version rather than changing just the example's
number. Intel builds use `--arch x64` on an Intel Mac. A universal native shell
may be used, but its runtime dependencies still belong to one target
architecture. `--no-build` on runtime preparation consumes already compiled
checkout artifacts; ordinary builds compile before staging.

The Node archive version and per-architecture SHA-256 values are committed in
`node-runtime.json`, taken from the official release's `SHASUMS256.txt`. Every
cached or downloaded archive is verified before extraction. Cached corruption
fails rather than silently replacing an artifact. The app includes Node/npm
licenses, the project license, third-party notices and trademark declarations.
A bundled private npm supports managed Codex installation; its launcher invokes
the bundled Node using absolute paths. The desktop runtime must prepend its
own directory to the daemon's PATH so managed installs select that npm.

The final layout is `Omnesis.app/Contents/MacOS/Omnesis` and
`Contents/Resources/runtime/{node,npm,lib,node_modules,packages}`. The native
bridge enters `runtime/runtime-exec --node` with the compiled
`packages/cli/dist/index.js desktop bridge` entry.
Assembly takes prebuilt inputs, checks version/architecture and the runtime
inventory, preserves internal relative links, and refuses existing outputs.
`--shell-app` preserves the native shell's privacy metadata, compiled assets and
embedded `OmnesisBackground.app` login item. `--executable` is available for a
minimal shell build but does not create a background login item. The prebuilt
shell must have the same product version and no prior embedded runtime.
The inventory rejects escaping/dangling symlinks, wrong-architecture Mach-O
code and non-macOS native modules. Hashes describe the unsigned build inputs;
code signing changes native bytes. Signed bundle integrity is checked by
`codesign`, and the final DMG gets its own SHA-256 file.

Signing is a separate explicit step using a configured Developer ID Application
identity. Do not put credential values in shell commands or source files;
diagnostic packaging uses an existing Keychain profile. Release tooling reads
protected environment secrets and reports fixed tool diagnostics. Omitting `--notary-profile` produces a
diagnostic DMG containing a signed app, without a notarization claim.

```sh
node scripts/desktop/distribute.mjs \
  --app /tmp/Omnesis.app --arch arm64 \
  --identity 'Developer ID Application: Example Organization (TEAMID)' \
  --notary-profile omnesis-notarization --out /tmp/Omnesis-0.8.1-macos-arm64.dmg
```

Nested Mach-O code and embedded app/framework containers are signed individually
before the outer app. JIT entitlements
apply to the bundled Node alone. A notarized build submits/staples the app,
checks Gatekeeper assessment, creates/signs the DMG, submits/staples it and
validates its ticket. None of this publishes an artifact.

The stable-tag release workflow optionally owns both native architecture builds,
signing and notarization with `OMNESIS_DESKTOP_RELEASE=1`. Its release-only wrapper
requires notarization and an isolated temporary signing Keychain. It uploads only
canonical `Omnesis-X.Y.Z-macos-{arm64,x64}.dmg` files and bounded manifests, then
verifies actual GitHub asset digests in a draft before publication. Both installers
must succeed before package/image publication starts. The default headless release
flow remains unchanged; local versioning reads no signing credentials.
See [the release configuration](../../docs/releasing.md#signed-macos-desktop-releases)
for required protected variables/secrets and interrupted-run recovery. These
commands and unsigned package checks are not evidence of a signed installed-app
qualification, and no script invocation here publishes a release by itself.

The packaging unit suite uses invented tiny Mach-O headers and prebuilt fixture
closures, never downloads dependencies or contacts production services:

```sh
npm run test:unit:vitest -- scripts/desktop
```

Use the repository's admitted check runner for heavy local validation. A real
macOS packaged-app smoke test remains necessary to prove native module loading,
service registration, TCC permissions and the user interface. Pure packaging
units do not prove those properties.

## Standalone native composition QA

The admitted `--build-only --package` qualification also prepares a portable
service artifact from its freshly compiled runtime and runs
`native-composition-smoke.mjs` with that artifact's Node. It exercises the actual
relay and native SQLite dependency, request-scoped TLS trust, scripted model HTTP
and DNS-backed ACME certificate issuance. It publishes package success evidence
only after the services child finishes normal shutdown. The returned raw tree
contains its own runtime and uses only internal relative links; it needs no
source loader, compiler or npm on the test computer.

`prepare-native-composition-services.mjs` is the fixed QA module compiler.
`prepare-native-composition-fixture.mjs` separately creates an unsigned Debug
application fixture from a matching native shell and an observed service-ready
receipt. The standalone service entry checks its packaged runtime, system crypto
tool and actual OS user before creating its own QA directory. Start the services
inside the disposable test OS before embedding their observed addresses and test
CAs in an application fixture.

These tools do not sign the fixture, grant permissions, configure system trust or
DNS, or perform account enrollment. Services-only smoke and packaging fixtures do
not establish native application startup, permission attribution, reboot or
multi-computer behavior. Those require separate tests using the real application
and controlled OS environments.
