# iOS — agent guide

Rules for working in `ios/`. The root `CLAUDE.md` carries repo-wide conventions; this file carries the iOS-specific contract. Read both.

## XcodeGen and project layout

The Xcode project is generated from `ios/project.yml` via XcodeGen (`brew install xcodegen`):

```bash
cd ios && xcodegen generate && open Omnesis.xcodeproj
```

Read [README.md](README.md) § "Independent device build" before changing signing or app identities. `ios/Config.xcconfig` supplies the official `OMNESIS_BUNDLE_ID` default and includes the ignored `ios/Local.xcconfig` last. Set a contributor's own base identifier and `DEVELOPMENT_TEAM` only in that local file; an authorized official-team developer may retain the default. Preserve official identifiers, existing Keychain access and the relay's explicit official-identity policy. Never assume access to another developer's Apple team, App IDs or credentials. Ask only for missing identifiers or Apple-account actions the developer must perform, then continue the implementation using ignored overrides.

**After editing `project.yml` or adding a new `*.swift` file, re-run `cd ios && xcodegen generate`** so the Xcode project picks it up. Forgetting this is the most common reason "cannot find type 'X' in scope" errors show up only at build time.

Code layout (`ios/Sources/Omnesis/`):

- `AppleHealth/` — HealthKit client + source
- `Collector/` — CollectorCore, Uploader, OfflineBuffer
- `Transport/` — GatewayClient, AdminClient, DeviceSocket, SearchClient
- `UI/` — SwiftUI views + `Theme.swift` design tokens + `PreviewMocks.swift` fixtures

## Application targets

`project.yml` declares three app targets: `Omnesis` (production iPhone app),
`OmnesisDemo` (identical code, distinct identity — see below), and
`OmnesisWatch` (the Apple Watch companion). `OmnesisWatch` is a single-target
SwiftUI watchOS app (`WKApplication`) embedded in the production app; it holds no
gateway pairing. Its two App Shortcuts relay a dictated utterance to the paired
iPhone over WatchConnectivity: **"Ask Omnesis"** relays a question, which the
phone answers via the shared `SiriAskRunner`; **"Omnesis note"** relays a note,
which the phone saves via the shared `NoteCaptureService` (attaching the phone's
location). The watch owns one WatchConnectivity session (`WatchLink`), the phone
one delegate (`WatchRelayReceiver`) that routes each message by its `kind`.
Source lives under `Sources/OmnesisWatch`, plus the dual-target-member relay
contracts `Sources/Omnesis/Intents/SiriAsk.swift` (ask),
`Sources/Omnesis/Intents/WatchNote.swift` (note) and
`Sources/Omnesis/Intents/WatchRelayDelivery.swift` (the delivery window, the
`transferUserInfo` fallback a relay is queued on when the iPhone app never
picks it up live, and the phone's handling of queued relays).

The watch also ships two complications, **Ask Omnesis** and **Omnesis note**,
from the `OmnesisWatchWidgets` WidgetKit extension embedded in the watch app. A
widget can only open its own app, so each complication is a `widgetURL` to its
`WatchComplication` link (`Sources/Omnesis/Intents/WatchComplication.swift`,
dual-membered into both watch targets); the app's `onOpenURL` hands it to
`WatchDictation`, which presents WatchKit's system text input controller with
**no suggestions and `.plain` mode**, the combination WatchKit documents as
going straight to dictation (a suggestion list, even an empty one, or emoji
mode shows the keyboard/Scribble picker first). SwiftUI `TextField` focus and
`TextFieldLink` cannot do this, and a widget cannot cross-launch Shortcuts, so
do not reach for either. Dictation does not run in the simulator, so the
complication-to-dictation path can only be checked on a physical watch.

### Screenshotting the watch ask — the wrist's self-critique loop

The SwiftUI preview + snapshot loop below is an iOS-simulator lane; watchOS
views render only in a watch simulator, so the wrist has its own:

```bash
scripts/shot-watch-ask.sh                       # every state, 41mm + 49mm
scripts/shot-watch-ask.sh --states widest,long-question --sizes small
scripts/shot-watch-ask.sh --keep                # leave the sims booted for the next run
```

It runs `xcodegen generate` (so it mutates `Omnesis.xcodeproj` like any other
iOS lane), builds the `OmnesisWatch` target, creates a throwaway watch
simulator (Xcode ships watch device _types_ but no devices, so there is
nothing to look up on a fresh machine), and launches the app once per state
with `DEMO_WATCH_STATE` set. PNGs land in `/tmp/omnesis-watch-shots/`; `Read`
them and critique as you would an iPhone snapshot.

`WatchStateStaging` in `WatchDemoAutoPilot.swift` owns the state list and
stages each one **without starting a relay**, then writes a marker file the
script waits on. So a capture depends on neither timing nor whether a phone is
in range, an unknown state name fails loudly instead of rendering a plausible
wrong screenshot, and an empty PNG is an error rather than something you
review. Keep the script's `KNOWN_STATES` in step with `WatchStateStaging.known`.

**Always look at `small`.** The ask screen's status line is a single line that
must never wrap or truncate, and 41mm is where it breaks first. Two states
exist purely to prove the edges hold: `widest` (the longest label this build
can emit, carrying a three-digit count — it must drop the count and keep the
phrase whole, never clip) and `long-question` (a dictated question taller than
the screen — it must scroll, not be cut off).

Overrides: `OMNESIS_WATCH_SMALL` / `OMNESIS_WATCH_LARGE` (simulator device
types), `OMNESIS_WATCH_READY_TIMEOUT`, `OMNESIS_WATCH_SETTLE`.

### Recording the watch flow

`scripts/record-watch-demos.sh` drives the whole ask end to end on a pair of
simulators and records the wrist. Four things about it are easy to rediscover
the hard way:

- **Two simulators, paired.** `simctl pair` is what makes WatchConnectivity work
  between them, and it must run with both devices shut down. Pairing also wipes
  third-party apps off the watch, so it has to happen before any install.
- **Code signing must stay on.** The simulator applies the app's entitlements
  through ad-hoc signing; `CODE_SIGNING_ALLOWED=NO` silently drops them and the
  `-pairingFile` keychain write fails without an error.
- **The link needs priming.** The phone only forwards progress snapshots while
  `WCSession.isReachable`, which takes several seconds to settle the first time
  two freshly-booted simulators connect. The script runs both apps once before
  recording anything; skip that and the first clip shows a wrist stuck on
  "Working…" for the whole turn.
- **One cassette per conversation.** The replay backend is single-turn, and
  `SiriAskContinuityStore` resumes the previous conversation for five minutes —
  so consecutive scenarios would all replay as `fixture_exhausted`. The reset is
  a phone-app reinstall: deleting the preferences plist does _not_ work, because
  `cfprefsd` keeps it cached and writes it back. Uninstalling the phone app also
  removes its companion watch app, and that removal is asynchronous — reinstall
  the watch side with a retry.

Siri can't be invoked in a simulator, so `WatchDemoAutoPilot` (`#if DEBUG`,
activated by `DEMO_WATCH_ASK`) hands the question to `WatchAskRouter` exactly
where `AskOmnesisIntent` would. Everything downstream is the real path.

Because the `Omnesis` scheme now embeds a watchOS app, building it requires the
**watchOS simulator runtime** installed on the build host, not just the SDK
(`xcodebuild -downloadPlatform watchOS`) — otherwise `xcodebuild -scheme
Omnesis` fails with "watchOS <ver> must be installed in order to run the
scheme". To compile-check only the watch app without a runtime:
`xcodebuild build -target OmnesisWatch -sdk watchsimulator<ver>`.

## Quick deploy to a paired physical device

Find the UDID with `xcrun xctrace list devices`, then:

```bash
cd ios && xcodebuild -project Omnesis.xcodeproj -scheme Omnesis \
  -configuration Debug -destination 'platform=iOS,id=<UDID>' \
  -allowProvisioningUpdates build && \
xcrun devicectl device install app --device <UDID> \
  ~/Library/Developer/Xcode/DerivedData/Omnesis-*/Build/Products/Debug-iphoneos/Omnesis.app && \
xcrun devicectl device process launch --device <UDID> <your-app-bundle-id>
```

When the user is away from the macOS build host, `devicectl install` doesn't work over Tailscale (no Bonjour/mDNS). Use the TestFlight pipeline in `ios/TESTFLIGHT.md` instead.

## OmnesisDemo — the side-by-side demo app

`project.yml` defines a second application target, `OmnesisDemo`, that ships identical code to `Omnesis` but with a distinct identity:

|                       | `Omnesis` (production)                                        | `OmnesisDemo`                             |
| --------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| Bundle id             | `dev.omnesis.ios`                                             | `dev.omnesis.ios.demo`                    |
| Display name          | Omnesis                                                       | Omnesis Demo                              |
| Info.plist            | `Info.plist`                                                  | `Info-Demo.plist`                         |
| Entitlements          | `Omnesis.entitlements`                                        | `Omnesis-Demo.entitlements`               |
| Keychain access group | `dev.omnesis.ios` plus shared `dev.omnesis.ios.notifications` | `dev.omnesis.ios.demo`                    |
| APS environment       | Debug `development`, Release `production`                     | Debug `development`, Release `production` |

Both apps install side-by-side on the same device. Because the keychain access groups differ, each app keeps its own paired gateway URL + token — pair the production app to your live gateway, pair the demo app to whatever the synth/replay demo gateway is serving (`scripts/start-demo-gateway.sh`), and flip between them by tapping the home-screen icon. **No more re-pairing your live setup just to demo.**

Build + install the demo target locally (the macOS build host, USB- or Wi-Fi-connected iPhone):

```bash
cd ios && xcodegen generate
xcodebuild -project Omnesis.xcodeproj -scheme OmnesisDemo \
  -configuration Debug -destination 'platform=iOS,id=<UDID>' \
  -allowProvisioningUpdates build
xcrun devicectl device install app --device <UDID> \
  ~/Library/Developer/Xcode/DerivedData/Omnesis-*/Build/Products/Debug-iphoneos/OmnesisDemo.app
```

`-allowProvisioningUpdates` lets Xcode request a development profile for an App ID your team owns. A custom-identity build may still need manual App ID and capability setup in the Apple Developer portal; see [README.md](README.md) § "Independent device build".

TestFlight delivery of the demo target **is** configured: it has its own App Store Connect app record, the `Omnesis Demo App Store` distribution profile, and an internal beta group. Uploads use the same archive→export→upload→compliance→notify pipeline as production but with `-scheme OmnesisDemo`, the demo `ExportOptions` (`dev.omnesis.ios.demo` → `Omnesis Demo App Store`), and the demo app record. Release resolves `aps-environment` to `production` for the App Store distribution profile; Debug resolves it to `development`. The full demo runbook + reference IDs live in the private `CLAUDE.local.md` (kept out of this checked-in file, same as the production runbook).

To pair the demo app: start the demo gateway, then mint an iOS pairing code against THAT gateway (point the CLI at the demo config dir):

```bash
bash scripts/start-demo-gateway.sh start
OMNESIS_CONFIG_DIR=/tmp/omnesis-agent-demo cli devices pair --kind ios
```

Scan the printed QR from the Omnesis Demo app. Production app stays paired to your live gateway, untouched.

## SwiftUI previews + visual feedback loop — mandatory

**This is the primary mechanism by which you, the agent, verify iOS UI changes without waiting for the user to look at the screen. Treat it as a hard requirement, not a nice-to-have.**

### The rules

1. **Every view in `ios/Sources/Omnesis/UI/` ships with at least one `#Preview` block.** No exceptions.

2. **Add as many `#Preview` blocks as needed to cover the view's edge cases.** A single happy-path preview is rarely enough. Think about which inputs change the layout and add a preview for each meaningful state, for example:
   - Empty state (no data, zero results, first-run)
   - Loading state (skeleton, spinner, placeholder)
   - Error state (network failure, permission denied, validation error)
   - Populated state at typical size
   - Populated state at extremes (1 item, hundreds of items, very long strings that test truncation/wrapping, very short strings)
   - State-machine variants (selected/unselected, expanded/collapsed, enabled/disabled, paid/free, online/offline)
   - Light + dark mode if the view has custom styling that isn't covered by `Theme.swift`
   - Dynamic Type extremes if the view has dense text

   If a state would lay out differently from the others, it earns its own preview. If you can't tell whether it lays out differently, add the preview — the cost is one block, the cost of missing a broken state is the user finding it for you.

3. **When you add a new view or materially change one, add or update its `#Preview` blocks in the same commit.** A PR that touches a view without touching its previews is incomplete.

4. **Mock data lives in `ios/Sources/Omnesis/UI/PreviewMocks.swift`** (gated on `#if DEBUG`). Use the existing fixtures (`PreviewMocks.sources`, `.peopleSummaries`, `.documentDetail`, `.searchResults`, `.statusSnapshot`, `.indexStats`, …) and **extend that file with new fixtures rather than scattering literals across preview blocks.** `AppStore.preview(...)` (in `App.swift`, `#if DEBUG`) builds a fully-populated store so views that require `@Environment(AppStore.self)` render without a paired gateway.

5. **Never seed fixtures from the user's corpus.** When you invent mock people, vendors, conversations, documents, or scenarios for previews/snapshots, invent them from scratch — not from anything you've seen in the user's actual emails, messages, contacts, calendar, or files. See the "Privacy — never use the user's corpus as inspiration" section in the root `CLAUDE.md` for the full rule and the invented-data conventions (`Maya Reeves`, `+1 (555) 010-0xxx`, `example.com`, etc.).

### The self-critique loop (you must run this before handing off to the user)

The point of all those previews is that **you** can render them to PNGs and look at them, then iterate, without ever asking the user "does this look right?" Run the snapshot suite:

```bash
xcodebuild -project ios/Omnesis.xcodeproj -scheme Omnesis \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:OmnesisTests/PreviewSnapshotTests test
```

PNGs land in `/tmp/omnesis-snapshots/` keyed by test name (e.g. `01-sources-populated.png`, `21-person-detail.png`). **The `Read` tool ingests PNGs.** Use it.

For every iOS UI change, the loop is:

1. Make the change.
2. Add or update `#Preview` blocks covering all relevant edge cases (see rules above).
3. Add or update the corresponding entries in `ios/Tests/OmnesisTests/PreviewSnapshotTests.swift` so the new previews render to PNGs.
4. Run the snapshot suite.
5. `Read` each PNG you touched and **critique it as if you were the user.** Things to look for: alignment, spacing, truncation, overflow, contrast, dark-mode regressions, empty-state emptiness, error-state legibility, accidental layout shifts in neighbouring views.
6. If anything looks off, fix it and go back to step 4. Iterate until _you_ are satisfied — not until you've run out of obvious things to check.
7. Only after that is the change ready to hand to the user for QA on a real device.

Telling the user "I made the change, can you tell me if it looks right?" without first running the loop is a failure mode. The previews + snapshot tool exist specifically so that doesn't happen.

When you add a new view, add a corresponding test in `ios/Tests/OmnesisTests/PreviewSnapshotTests.swift` so the visual regression net stays complete.

### Bridging the snapshot loop from a non-macOS box

If you're running on a host without Xcode (e.g. the Linux dev box), you can still run the snapshot loop on a configured macOS build host with **one command**:

```bash
export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>
scripts/ios-snapshot.sh                                  # the default PreviewSnapshotTests suite
scripts/ios-snapshot.sh OmnesisTests/PreviewSnapshotTests/testPersonDetail   # one case
```

`scripts/ios-snapshot.sh` rsyncs your **uncommitted** `ios/` working tree to a **dedicated scratch checkout** on the host (it hard-fails if the target resolves into the primary checkout or a CI runner `_work` clone — it never touches live state), runs the suite over `ssh` with code-signing disabled (a simulator render needs none), then rsyncs the PNGs back to `/tmp/omnesis-snapshots/` on the local box so you can `Read` them. It fails loud at every step (unreachable host, rsync error, build/test failure, or zero PNGs produced) — never a silent empty success. Configure the scratch path / destination / output dir via the env vars documented at the top of the script. Then run the same `Read` + self-critique loop above on the returned PNGs.

## Fast inner loops (native lanes)

The snapshot lane above is the _visual_ gold-standard — but it builds for the simulator, which takes minutes. For a **pure-logic** change (an agent timeline/turn builder, the health normalizer/cursor, schemas, the offline buffer, markdown streaming, a sync-reminder timing) reach first for the **sim-less logic lane**, which gives sub-minute feedback before you pay for a device build:

```bash
export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>
scripts/ios-logic.sh                          # the whole logic suite
scripts/ios-logic.sh AgentTurnBuilderTests    # one XCTest class (swift test --filter)
```

`scripts/ios-logic.sh` mirrors `ios-snapshot.sh`'s bridge shape (env-host + path-guard + rsync-up) but runs **`swift test`** against `ios/Package.swift` — building + running the `OmnesisTests` SwiftPM target **natively for macOS, with no simulator, no Xcode project, and no device build**. The iOS-only UI is `#if canImport(UIKit)`-compiled-out of the `Omnesis` library on macOS, and the three UIKit-touching / live-gateway tests (`PreviewSnapshotTests`, `AppearanceTests`, `GatewayLiveE2ETests`) are `exclude`d from the SwiftPM test target in `Package.swift` so the lane stays sim-less. **Keep that exclude list in sync** — a new UIKit-touching or live-gateway test must be added to it, or the logic lane breaks.

The scratch checkout is kept **warm**: `ios-logic.sh` rsyncs into a persistent dir (default `~/omnesis-ios-logic` on the host, override with `OMNESIS_EPIC_MACOS_IOS_LOGIC_WORKTREE`) and **preserves the SwiftPM `.build` cache** across runs (it excludes `.build` from the up-sync, so the host's compiled cache survives), so a repeat run skips most recompilation. The full suite — snapshot + UI + live tests included — still runs via `xcodebuild test` on the simulator through `ios-snapshot.sh`; use the logic lane while iterating, the snapshot lane to self-critique a UI change.

## SwiftLint, SwiftFormat, and the baseline's line-count coupling

CI pins both tools (`.github/workflows/swiftlint.yml` — an upstream release asset with a
SHA256 check, not `brew install`, whose version on a reused runner is whatever that machine
last fetched). Run those exact versions locally, or you will chase verdicts CI does not have.

`.swiftlint-baseline.json` suppresses the pre-existing violations, matching one by
**(file, rule, reason)**. `file_length`'s reason embeds the file's live line count — "currently
contains 2907" — and, unlike `type_body_length` and `function_body_length`, it counts comments.
So **adding a single comment to an already-oversized file unmatches its baseline entry**, the
violation resurfaces, and CI goes red on a change that touched nothing but a comment. About
thirty files are in that state. Regenerating the baseline needs macOS, which is the part that
hurts if you are working from Linux. See #76 for the proposed fix.

Two more traps worth knowing before you edit Swift:

- A plain `//` comment placed between a `///` doc comment and its declaration **detaches** the
  doc comment: SwiftFormat's `docComments` and SwiftLint's `orphaned_doc_comment` both fire.
  Put the note inside the doc block, or above it with a blank line.
- `swiftlint --strict --write-baseline` must be run **outside `/tmp`** on macOS. `/tmp` symlinks
  to `/private/tmp`, and a baseline written through the symlink silently matches nothing —
  it looks regenerated and suppresses nothing.

Before absorbing a regenerated baseline, compare entry counts by (file, rule) rather than by
diff size, and confirm nothing NEW became suppressed. A baseline that quietly grows is how a
red job stays hidden.

## Gateway fetch failures

Pages that fetch from the gateway route load failures through `GatewayErrorView(context:error:onRetry:)` in `ios/Sources/Omnesis/UI/GatewayErrorView.swift`. Pass the underlying `Error?` (not a pre-stringified message) and a short verb-phrase `context` ("load watches", "run the search", "start the agent"). The view classifies `URLError` / `GatewayClient.Error` shapes into shared copy, an SF-symbol icon, a Retry button, and an "Open settings" link. Inside the Settings navigation stack that link returns to the existing Settings root; elsewhere it presents `SettingsView` as a sheet.

Rules:

- **Store `Error?`, not `String?`**, on the view or coordinator. Pre-stringifying loses the type information the classifier needs to pick the right `Kind` (e.g. `URLError` → "Couldn't connect to gateway" vs. `GatewayClient.Error.unauthorized` → "Authentication failed — re-pair").
- **Don't roll your own error placeholder.** If the classifier is missing a case you need, extend `GatewayErrorView.Kind` (and `classify(_:)`) — don't branch downstream.
- **Embedded inside a `ScrollView`?** Apply `.frame(minHeight: GatewayErrorView.minScrollHeight)` so the inner content doesn't collapse.
- **Cached-data + refresh-failure surfaces** (e.g. `SourcesView`'s populated list with a stale refresh error) read `GatewayErrorView.classify(_:)` directly and render a short one-line banner instead of replacing the list with a full-screen error. Keep both surfaces driven by the same classifier so the vocabulary stays consistent.
- **`GatewayErrorView.Kind` is `Equatable`** — unit tests on the classifier live in `ios/Tests/OmnesisTests/GatewayErrorViewTests.swift`. Add cases there when extending the enum.

## Live-gateway E2E tests

`ios/Tests/OmnesisTests/GatewayLiveE2ETests.swift` runs the Swift transport clients (`GatewayClient`, `SearchClient`, `AdminClient`, `PrivacyClient`) against a real gateway process — catches the regression class no mock can: gateway response payload renames, route moves, scope tightenings. Existing `*ClientTests.swift` files mock the HTTP layer and stay; this is the complement.

Run it via the wrapper:

```bash
scripts/run-ios-e2e.sh
```

The wrapper boots a synth gateway on port 17601 with the `e2e-minimal` universe, seeds sources, waits for `Jane Doe` to resolve in the people graph, writes `/tmp/omnesis-ios-e2e-config.json` (gateway URL + token), then runs `xcodebuild test -only-testing:OmnesisTests/GatewayLiveE2ETests`. The test class reads that file in `setUpWithError`; if the file is missing it throws `XCTSkip` so plain `xcodebuild test` doesn't fail on the missing gateway.

The simulator inherits the macOS user's filesystem access, so reading host `/tmp` from inside the test works. Env vars passed via `xcodebuild test FOO=bar` don't propagate into the simulator-side test runner — that's why the file-handoff exists instead.

TLS: the test uses a `URLSession` with an "accept any cert" delegate (`AcceptAnyCertDelegate` in the same file) since the synth gateway uses an auto-generated self-signed cert and the test bypasses pairing. Production stays on `OmnesisURLSession.shared` with its pinned trust path.

Not covered by this suite (intentional follow-ups): pairing-flow E2E (the test uses the bootstrap admin token directly), DeviceSocket SSE subscription, and `AdminClient.listDescriptors` — that last one caught a real iOS bug (`SerializedDescriptor.importBased` / `pushBased` declared non-optional but the gateway doesn't emit those keys); the test is omitted with a TODO comment in the file pointing at the decoder fix.

## Remote deploy via TestFlight

When the user is away from the macOS build host and `devicectl` install isn't viable, the full TestFlight pipeline (archive → export → upload → export-compliance PATCH → tester notification) is documented in `ios/TESTFLIGHT.md` and the "Remote iOS test via TestFlight" section of root `CLAUDE.local.md`. Read those before attempting a remote test.
