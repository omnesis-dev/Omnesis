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
library: `swift test --package-path macos`. UI tests use the generated Xcode
project and a macOS destination. Admit builds and tests through the host's
configured native test queue when one is installed.

The complete app bundles the compiled runtime under
`Omnesis.app/Contents/Resources/runtime/`: `node` and
`packages/cli/dist/index.js` plus its package closure. A development build can
point at that same staged layout with `OMNESIS_DESKTOP_RUNTIME_DIR`. The app
refuses to launch an incomplete bundle; it never substitutes a globally installed
CLI or another checkout.

The app starts `desktop bridge` over a private JSON-lines pipe. Lifecycle replies
and interaction prompts determine the real onboarding state. Gateway tokens stay
in memory, never in URLs or Preferences. A home library only becomes available
when the runtime confirms encrypted storage. Local certificates are pinned via
the shared Apple transport client.

The optional `OmnesisBackground.app` login item runs `desktop daemon` and is
registered through `SMAppService` after the user enables background operation in
Settings. It does not request root access. Disable the login item before removing
the app if you no longer want it to start at login. Stopping Omnesis preserves the
library. Removing data is a separate explicit operation.

Native sources use provider descriptors and the existing discovery, validation,
credentials, authorization and add endpoints. Chat shares the Apple `AgentClient`
for HTTP/SSE and conversation persistence. App Intents expose a new conversation
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
keeps the real user home for Keychain and prefixes the bundled `runtime/bin`.
