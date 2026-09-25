# Omnesis iOS

Native iOS companion for Omnesis. It searches and manages a paired gateway and securely sends user-enabled phone-source data to that gateway over HTTPS.

- Source layout: see "Layout" below; canonical reference is the code in `Sources/Omnesis/AppleHealth/` and the iOS section in [`../CLAUDE.md`](../CLAUDE.md).
- Privacy policy: [omnesis.dev/mobile-privacy-policy](https://omnesis.dev/mobile-privacy-policy)
- App Store metadata drafts: [`APP_STORE_METADATA.md`](APP_STORE_METADATA.md)

## Layout

```
ios/
├── Package.swift                    # plain SwiftPM library (testable with `swift test`)
├── Info.plist                       # iOS app bundle info
├── Omnesis.entitlements             # HealthKit + Keychain capabilities
├── Sources/Omnesis/
│   ├── App.swift                    # @main scene + AppStore (iOS-only, gated by #if canImport(UIKit))
│   ├── Pairing/                     # PairingPayload, PairingService, Keychain
│   ├── Transport/                   # GatewayClient, AnalyticsSchema, JSONValue
│   ├── Collector/                   # CollectorCore, OfflineBuffer, CursorStore, Uploader, BackgroundTaskCoordinator
│   ├── AppleHealth/                 # TypeCatalog, Schemas, HealthKitClient, SampleReader,
│   │                                #   AppleHealthSource, BackgroundDelivery, HealthSettings
│   ├── UI/                          # Onboarding, Pairing, HealthKitPermissions, Status, Settings
│   └── Diagnostics/                 # AppLog (os.Logger wrapper)
├── Tests/OmnesisTests/              # XCTest suite — non-UI logic only
└── Resources/
    └── Assets.xcassets/             # AppIcon + AccentColor
```

## Package.swift — why a library target, not an iOS app

The `.iOSApplication(...)` product from `AppleProductTypes` is an Xcode-only API; plain `swift build` on the command line can't import it. That prevents CI from running tests without Xcode and complicates local verification.

Instead, this package declares a plain **library** target that compiles on macOS and iOS:

- Non-UI code (Pairing, Transport, Diagnostics) is platform-agnostic Swift. `swift test` runs it on the macOS host — no simulator needed.
- SwiftUI views and AVFoundation-backed QR scanning are guarded by `#if canImport(UIKit) && canImport(SwiftUI)`, so they compile in Xcode on iOS and are skipped on macOS.
- The iOS app's `@main` entry point (`OmnesisApp`) lives in `App.swift`, also behind the `UIKit` gate.

Use the generated `Omnesis.xcodeproj` to build the iOS app. Opening the Swift package alone builds the library and tests, not the signed app and its embedded targets.

## Running tests locally

Tests cover pairing codec, Keychain-backed service, and HTTP client with a mock `URLSessionLike`:

```bash
cd ios
swift test
```

No Xcode or simulator needed — XCTest runs on the host.

## Building / running the app in Xcode

```bash
cd ios && xcodegen generate && open Omnesis.xcodeproj
```

### Independent device build

Cloning the source does not grant signing rights to the official `dev.omnesis.ios` App ID. If your Apple team is not authorized for it, register your own base identifier under your team and use the ignored local override. An authorized official-team developer can keep the default identity and set only their team. A simulator build does not need your Apple team or a provisioning profile; a physical phone build does.

1. Join the Apple Developer Program for physical-device capabilities. In Certificates, Identifiers & Profiles, create an explicit App ID for your base identifier (for example, `com.example.myomnesis`). Prepare matching identifiers for the app's embedded notification service (`.notification-service`), widgets (`.widgets`), Watch app (`.watchkitapp`) and Watch complications (`.watchkitapp.widgets`). The optional demo app uses `.demo` and needs its own App ID if you build it. Enable the capabilities each target requests in Xcode: the phone app needs HealthKit, Push Notifications and Time Sensitive Notifications; the demo needs HealthKit and Push Notifications. The notification service must share the app's Keychain access group. The widgets, Watch and Watch complications targets do not hold pairing credentials. Apple may require capability or provisioning changes in the Developer portal before Xcode can sign these targets.
2. Copy `Local.xcconfig.example` to `Local.xcconfig` and set `OMNESIS_BUNDLE_ID` to the base identifier and `DEVELOPMENT_TEAM` to your 10-character Team ID (shown in Apple Developer account membership details). `Local.xcconfig` is ignored by Git. The tracked `Config.xcconfig` supplies the official default, then includes your local file so your override wins. The generated app, demo, embedded extensions, Watch companion reference and Keychain groups derive from the same base. Do not edit tracked identifiers to personalize a build.
3. Run `xcodegen generate` from `ios/` and open `Omnesis.xcodeproj`. Select the `Omnesis` scheme and your connected iPhone. In Signing & Capabilities, confirm every target uses your team and the expected identifier. For a local Debug build, use automatic signing and let Xcode create development provisioning profiles; sign in to your Apple account in Xcode if prompted. If you just enabled a capability, refresh or regenerate the affected profile and build again. Run with ⌘R to install. The Release configuration carries official distribution profile names, so an independent distribution archive requires your own profiles and export configuration.
4. Pair the installed app with your gateway using `omnesis devices pair --kind ios`. Grant notification permission when prompted. The app obtains and registers its APNs device token automatically; do not copy a carrier token by hand.

Keep `Local.xcconfig`, Apple keys, provisioning profiles and signing credentials outside Git. Before opening a PR, inspect `git status` and the diff to ensure it contains no local signing values or changes to the official defaults. The same tracked project remains usable by authorized official-team builders.

If a custom build and the official app coexist on one phone, both currently register the `omnesis://` URL scheme. iOS may open either app for links using that scheme; select the intended app directly when pairing or testing it.

### Background notifications for a custom identity

Installing over USB does not decide whether the hosted relay can serve an app. The relay supports explicit official app identities: an official-identity build signed by an authorized team may be eligible, subject to relay consent, APNs registration and the build's APNs environment. An independently registered identity normally needs direct APNs credentials on its paired gateway. A foreground socket notification only proves the live connection; it does not prove background APNs delivery.

For direct delivery, create an APNs `.p8` authentication key for your Apple team and have its Key ID, Team ID and the app's **actual** bundle identifier ready. `omnesis push setup` also asks for a separate App Store Connect API `.p8` key, Key ID and issuer ID with Certificates, Identifiers & Profiles access to verify or enable Push Notifications on that App ID. That management key is used by setup, not on each push. Choose **sandbox** for a normal Xcode development build and **production** for distribution; the gateway configuration must match the signed app's provisioning environment. Refresh the provisioning profile and rebuild if push was newly enabled.

Run `omnesis push setup` and select iOS, then check `omnesis push status` and send `omnesis push test --device <name-or-id>` after the phone is paired and notification permission is granted. The wizard sends the APNs key's filesystem path to the gateway, which reads and imports it into its managed configuration directory. The simplest arrangement is running the CLI on the gateway host with the key at a path the gateway process can read. If the CLI runs remotely or the gateway is containerized, place the key in a gateway-visible path first; a path on your laptop is not uploaded automatically. The existing config write hot-swaps the gateway's APNs client, so no restart is needed. A carrier wake still requires the phone to reach its gateway to fetch private notification content.

See the maintained [Notifications guide](https://omnesis.dev/docs/notifications#setup) for the direct setup workflow and [status and repair](https://omnesis.dev/docs/notifications#status) for diagnosis. Keep the Apple keys and managed gateway credential out of the repository.

## Pairing flow

1. On your Mac: `npm run gateway`, `npm run collector`, `npm run cli -- devices pair` (pick kind `ios`).
2. A QR code containing the gateway URL, a short-lived pairing code, and its TLS trust policy
   renders in the terminal. An exact public HTTPS origin configured on the gateway uses normal
   system certificate and hostname verification, so certificate renewal is transparent. Private
   and self-signed origins remain protected by a leaf fingerprint.
3. Open Omnesis on the iPhone or iPad → "Pair with Mac" → scan. The app exchanges
   the short-lived code for this device's own token.
4. The app stores its URL, token, and device identity in the device-only Keychain. Pair each physical
   iPhone or iPad separately; credentials do not sync through iCloud or device restore.
5. Status screen probes `GET /health` to confirm the connection.

Falls back to "Paste JSON" for simulators without a physical camera.

## App flow

1. **OnboardingView** — explainer and single "Pair with Mac" CTA.
2. **PairingView** — camera QR scanner (with "Paste JSON" fallback for simulators). Persists `(url, token, accountId, gatewayName)` into Keychain.
3. **HomeView** — paired users land in the app, where phone setup offers Apple Health, Places, Photos, Movement and notifications, each with its own page before iOS asks for access. Every source starts off, and each can be turned on or off later from Settings.
4. **SettingsView** — edit the gateway URL, enable phone-hosted sources, re-run the HealthKit prompt, and unpair. Detected permission loss appears globally and links to a source-permission repair screen.

iOS does not reveal whether individual HealthKit read permissions were denied, so an empty Health query is never treated as proof of revocation. Users can re-run the Health permission prompt from Settings. Apple Health, Activity Segments, and Photos report Background App Refresh health separately from source authorization. Photos deletion reconciliation runs only from a complete Full Access snapshot; Limited or denied access never makes inaccessible assets look deleted. Notification deliveries remain unconfirmed at the gateway when current iOS settings cannot visibly present them, so restoring notification access can retry the leased delivery.

Per-category toggles persist via `HealthSettings` (UserDefaults-backed). Disabled categories are filtered out of the `AppleHealthSource` catalog rotation on the fly — no re-pair needed.
