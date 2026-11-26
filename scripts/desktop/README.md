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
identity. Credentials are never arguments or source files; notarization uses a
previously configured Keychain profile. Omitting `--notary-profile` produces a
signed diagnostic DMG without a notarization claim.

```sh
node scripts/desktop/distribute.mjs \
  --app /tmp/Omnesis.app --arch arm64 \
  --identity 'Developer ID Application: Example Organization (TEAMID)' \
  --notary-profile omnesis-notarization --out /tmp/Omnesis-arm64.dmg
```

Nested Mach-O code and embedded app/framework containers are signed individually
before the outer app. JIT entitlements
apply to the bundled Node alone. A notarized build submits/staples the app,
checks Gatekeeper assessment, creates/signs the DMG, submits/staples it and
validates its ticket. None of this publishes an artifact.

The packaging unit suite uses invented tiny Mach-O headers and prebuilt fixture
closures, never downloads dependencies or contacts production services:

```sh
npm run test:unit:vitest -- scripts/desktop
```

Use the repository's admitted check runner for heavy local validation. A real
macOS packaged-app smoke test remains necessary to prove native module loading,
service registration, TCC permissions and the user interface. Pure packaging
units do not prove those properties.
