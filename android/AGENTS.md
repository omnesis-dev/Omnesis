# Omnesis Android — agent guide

Native Kotlin + Jetpack Compose client for the Omnesis gateway at feature parity
with the iOS app, including device-hosted health ingestion (`:feature-health`
syncs Health Connect to the gateway the way iOS hosts Apple Health). Built and
validated entirely from the CLI — no Android Studio on the critical path — mirroring
how `ios/` is driven by xcodegen + xcodebuild. **The iOS app under `ios/` is the
canonical reference** for behavior and the wire contract; port its
Transport/Pairing/UI split idiomatically.

The full plan lives at `~/.claude/plans/gentle-inventing-balloon.md` (+ a companion
design doc in the same dir). Read it before non-trivial work.

## Environment

Source the env helper before any gradle/adb/emulator command:

```bash
source android/scripts/android-env.sh
```

It locates JDK 17 (Homebrew `openjdk@17`, keg-only) and the Android SDK
(`~/Library/Android/sdk`, compile/target SDK 36) and puts `adb`/`emulator`/
`sdkmanager` on PATH. Builds use the **committed Gradle wrapper** (`./gradlew`,
pinned to Gradle 8.11.1) — never a system Gradle.

## Build & run

```bash
cd android
./gradlew :app:assembleFullDebug        # self-built edition, including Call Log
# -> app/build/outputs/apk/full/debug/app-full-debug.apk

# boot the arm64 AVD (first cold boot ~30s):
emulator -avd omnesis_pixel -no-snapshot -no-boot-anim -gpu auto &
adb wait-for-device
adb install -r app/build/outputs/apk/full/debug/app-full-debug.apk
adb shell am start -n dev.omnesis.android/.MainActivity  # use your application id for a custom build
adb exec-out screencap -p > /tmp/omnesis-android-shots/NN-screen.png
```

For an independently signed install, use a package id you control. The ignored
`android/local.push.properties` may set `OMNESIS_ANDROID_APPLICATION_ID`; the
`omnesis push setup` wizard writes it alongside Firebase client values. The app
namespace stays `dev.omnesis.android`, but launch commands and shortcut targets
must use the resulting application id. See `android/README.md`.

Logs: `adb logcat -s Omnesis:* OkHttp:*`. The emulator reaches a gateway on the
host at **`10.0.2.2`** (not `localhost`).

## MANDATORY — render and review every view yourself

This is the Android analogue of the iOS preview + snapshot self-critique loop, and
it is **non-negotiable**: visually verify every screen you build before claiming it
done, and **never present the user a layout you have not looked at yourself.**

PNGs are produced by **explicit `captureRoboImage` cases**, not by a `@Preview`
scanner — Roborazzi here renders only the composables a test hands it. Each surface
has a `*ScreenshotTest.kt` under
`app/src/test/kotlin/dev/omnesis/android/screenshots/` (and one in `:feature-health`)
whose `@Test` methods call a local `capture(name, dark) { … }` helper wrapping
`captureRoboImage(filePath = "build/outputs/roborazzi/$name.png") { … }`. **`@Preview`
annotations on the production composables are NOT what gets rendered** — adding a new
`@Preview` produces no PNG. To cover a new state you add an explicit `captureRoboImage`
case to the matching `*ScreenshotTest.kt` (cover each meaningful state **and light +
dark**). Then record the PNGs and `Read` each one:

```bash
./gradlew :app:recordRoborazziPlayDebug # -> app/src/test/roborazzi/*.png (tracked goldens)
```

Critique alignment, truncation, overflow, contrast, dark mode, and empty/error/
loading states. Iterate until correct.

The recorded PNGs are the **tracked goldens**: each `captureRoboImage` writes to
`filePath = "src/test/roborazzi/<name>.png"` (under `:app` and `:feature-health`),
a committed dir — so the app's `verifyRoborazziPlayDebug` (or a library module's
`verifyRoborazziDebug`) can compare a fresh render against a checked-in baseline
in CI (`android.yml`, below). `recordRoborazziPlayDebug` rewrites the app goldens;
the verify run's diff/actual/compare artifacts go to the gitignored
`build/outputs/roborazzi-compare/`, never the tracked dir. **A golden only catches
*drift* from its first capture** — so when you record a NEW or changed golden, you
must `Read` it and self-critique it before committing, or an already-wrong first
render becomes the baseline and the bug is locked in.

### Bridging the screenshot loop from a non-macOS box

The Android SDK + AGP-downloaded `aapt2` ship only for `linux-x86_64` and macOS —
there is **no `linux-aarch64`** build — so on an aarch64 Linux box even
`./gradlew test` fails its resource transform. `scripts/android-render.sh` bridges
the whole loop to a configured macOS build host over `ssh` (the Android analogue
of `scripts/ios-snapshot.sh`): it rsyncs the **uncommitted** `android/` tree to a
dedicated scratch checkout on the host, runs the Roborazzi suite there with the
Android toolchain exported inline, and rsyncs the PNGs **back** to `/tmp` for you
to `Read`.

```bash
export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>   # unset → a clear error; never guessed
scripts/android-render.sh            # record all goldens → /tmp/omnesis-android-shots
scripts/android-render.sh --verify   # CI-style compare against the tracked goldens
```

It refuses to rsync onto live state: the scratch path is resolved on the host and
hard-rejected if it is a `_work` runner clone, the host HOME, or a `.omnesis-primary`-
marked primary checkout. It never pushes/commits on the host — all git mutations
stay with the caller.

> **Every infinite animation MUST be gated on `LocalInspectionMode.current`.** Each
> test's `capture()` helper renders inside `CompositionLocalProvider(LocalInspectionMode
> provides true)`, so any `rememberInfiniteTransition` / looping `LaunchedEffect` that
> does **not** check inspection mode never idles and **hangs the native screenshot
> capture forever** (you'll see a Gradle worker pinned at ~97% CPU writing zero PNGs).
> Pattern: `if (LocalInspectionMode.current) { /* freeze at a representative frame */ }
> else { rememberInfiniteTransition(...) }` — see `AgentBubbles` (the citing pulse and
> the thinking dots/shimmer). See the gotchas below for how to bisect a hang.

### Fast inner loops (native lanes)

The Roborazzi lane above is the *visual* gold-standard, but it renders Compose to PNGs and is the slow lane. For a **pure-logic** change (the transport decoders, pairing, an agent reducer/turn builder, the health normalizer/cursor) reach first for the **JVM-only logic lane**, which gives sub-second feedback with **no emulator and no Roborazzi render**:

```bash
export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>
scripts/android-logic.sh                                 # the core pure-logic JVM modules
scripts/android-logic.sh --module :feature-health        # one module's testDebugUnitTest
scripts/android-logic.sh --tests dev.omnesis.android.transport.dto.DtoDecodeTest
```

`scripts/android-logic.sh` mirrors `android-render.sh`'s bridge shape (env-host + path-guard + rsync-up) but runs `./gradlew <module>:testDebugUnitTest` — the plain-JVM unit lane, no AVD, no Robolectric Compose rasterisation. The default scopes to the modules whose tests are pure JVM logic (`:core-transport`, `:core-pairing`, `:core-designsystem`); the `:app` and `:feature-health` modules share a module with the slow Roborazzi screenshot tests, so narrow those with `--module` + `--tests` (e.g. `--module :feature-health --tests *HealthNormalizerTest`).

The scratch checkout is kept **warm**: the script rsyncs into a persistent dir (default `~/omnesis-android-logic` on the host, override with `OMNESIS_EPIC_MACOS_ANDROID_LOGIC_WORKTREE`) and **preserves the Gradle build cache** across runs (it excludes `.gradle` / `build` from the up-sync, so the host's caches survive) and opts into the **configuration cache** (`--configuration-cache`, a lane-local flag — `gradle.properties` keeps it off globally so the Roborazzi/CI lanes are unaffected). So a repeat run skips the configuration phase and most recompilation. Use this lane while iterating on logic; the Roborazzi lane to self-critique a UI change.

## Tests (rigor matches iOS)

- **Unit** (`./gradlew test`, JVM/Robolectric): port the iOS unit tests —
  `PairingPayload`, `PairingService` (with an `InMemoryStore`), `SSEFrameParser`,
  `AgentTurnBuilder` / the agent-coordinator ephemeral gate, `LeafCertPinner` digest
  accept/reject, DTO decode from captured gateway JSON (OkHttp `MockWebServer`), and
  the `GatewayException` classifier.
- **Screenshot**: `:app:recordRoborazziPlayDebug` (record the tracked goldens) /
  `:app:verifyRoborazziPlayDebug` (compare against them — what CI runs). The
  unflavored task names remain correct for library modules such as
  `:feature-health`. `scripts/android-render.sh` bridges both forms to a macOS host.
- **Live-gateway E2E** (the port of `ios/Tests/.../GatewayLiveE2ETests.swift`):
  `scripts/run-android-e2e.sh` boots a synth gateway on a high port and runs the real
  transport clients against it via `10.0.2.2`. A green E2E is a **per-phase gate**.

### Tier B — instrumented Health Connect round-trip

`:feature-health` ships a self-contained androidTest APK (library-module
testing) that runs the production `HealthConnectSource` against the **real**
Health Connect provider — the layer the JVM fakes can't cover. One `@LargeTest`
(`HealthConnectRoundTripTest`) plays both writer and reader: it seeds invented
records (`SyntheticHealthData`: weights, steps, a multi-sample heart rate, a
staged sleep session) via `insertRecords`, drains them through the production
sync path, and proves the provider honors the whole cursor model — baseline
read → changes-token delta (including the fan-out pre-delete tombstone page) →
deletion tombstones.

- **Run (connected — the verification lane)**: boot the AVD, then
  `./gradlew :feature-health:connectedDebugAndroidTest` (green run ≈ 20 s warm).
- **Run (CI-style, Gradle Managed Device)**:
  `./gradlew :feature-health:tierbDebugAndroidTest` — Pixel 7, API 34 google
  image; the first run downloads the system image (slow).
- **Health permissions cannot be `pm grant`-ed.** `android.permission.health.*`
  is owned by Health Connect; only its consent UI can flip them.
  `HealthPermissionGate` fires the request — the permission contract's intent
  on the APK-provider path (API < 34), plain `Activity.requestPermissions` on
  the framework module (API 34+, where the contract yields the synthetic
  `ActivityResultContracts.RequestMultiplePermissions` action that only a
  `ComponentActivity`'s result registry can dispatch — a raw
  `startActivityForResult` throws `ActivityNotFoundException`) — then drives
  the sheet with UiAutomator in priority order: "Get started" → "OK" (clears
  any system dialog overlaying the sheet) → "Allow all" (clicked once) →
  unchecked per-type toggles → bounded scroll → "Allow" → "Done". The confirm
  click comes **after** the toggles ("Allow" earlier grants only what's
  toggled), and scrolling is **bounded** because HC's list keeps reporting
  scrollable content at the bottom — an unbounded scroll loop starves the
  confirm click forever. On failure the gate screenshots to the test app's
  external-files dir and the test **skips** (`AssumptionViolatedException`)
  rather than fails; manual fallback: Health Connect → App permissions →
  allow everything for the test app, re-run.
- **Clean slate without nuking grants**: setup/teardown delete leftovers by
  `clientRecordId` prefix (`omnesis-tierb-`). Never `pm clear` the provider —
  that wipes the permission grants.
- **Quirks**: the androidTest APK needs `testOptions.targetSdk` set (it
  otherwise defaults to minSdk 26, and Android 15 overlays a
  DeprecatedTargetSdkVersionDialog that blocks the consent sheet);
  `selfPackageName` passed to the source must NOT be the test package — the
  seeded rows carry the test package as `dataOrigin` and self-origin filtering
  would drop them all; record types newer than the device's HC module
  (Mindfulness on the API 35 image) surface as
  `UnsupportedOperationException`/`LinkageError` and the engine skips them
  per-type; a blank host activity stays RESUMED throughout so reads don't need
  the background-read grant; AGP uninstalls the test APK after each connected
  run, so every run redoes the consent dance (idempotent — already-granted
  state skips the UI entirely).

## Gotchas / hard-won lessons

Things that have bitten agents working in this module. Read before testing.

### Roborazzi screenshots

- **Record mode actually renders; the normal test lane does not.** `:app:testPlayDebugUnitTest`
  runs with `roborazzi.test.record=false`, so `captureRoboImage` is a **no-op** — the
  composable is never rasterised. A green `test`/unit-test task therefore tells you
  **nothing** about whether a screen renders. Only `:app:recordRoborazziPlayDebug`
  (`roborazzi.test.record=true`) truly renders. Always record + `Read` the PNGs.
- **Infinite animations hang record mode** — see the boxed rule above. Symptom: a Gradle
  worker (`GradleWorkerMain` / `Gradle Test Executor`) pinned near 97% CPU for minutes
  with **no new** files under `app/build/outputs/roborazzi/` (the run may write the first N
  PNGs, then stall on test N+1). Fix: gate the animation on `LocalInspectionMode.current`.
- **The subtle one: indeterminate progress spinners.** A raw indeterminate
  `CircularProgressIndicator` animates forever and hangs capture just like a
  `rememberInfiniteTransition` — but it's easy to miss because it looks static. **Always use
  `OmSpinner` (`core-designsystem`), never a raw `CircularProgressIndicator`** — `OmSpinner`
  renders a static determinate arc under `LocalInspectionMode` and the live indeterminate
  spinner otherwise. Any loading-state screenshot built on a raw spinner will hang.
- **Every screenshot test's `capture()` helper MUST wrap content in
  `CompositionLocalProvider(LocalInspectionMode provides true)`.** This is the linchpin —
  `OmSpinner` and every `if (LocalInspectionMode.current)` gate only freeze when inspection
  mode is actually set, and Roborazzi does **not** set it by default. If one test class's
  helper sets it and another's doesn't, the second class hangs on its first loading/animated
  state even though identical components render fine in the first. When adding a new
  screenshot test class, copy the helper shape from an existing one and keep the wrapper.
- To **find** a hanging test, don't record the whole class — bisect with a method-level
  filter. **Use the Kotlin method name, not the `capture("…")` PNG name** (a wrong name
  fails fast with `No tests found for given includes`, which masquerades as a build error):
  ```bash
  ./gradlew :app:recordRoborazziPlayDebug \
    --tests "dev.omnesis.android.screenshots.AgentParityScreenshotTest.citations_drawer_populated_light"
  ```
- **CI runs the Android lane (`android.yml`).** Full validation calls this reusable
  workflow for every pull request and push to `main`, on a GitHub-hosted arm64 macOS runner. It runs
  both app flavor unit suites, release policy and bundle checks, Roborazzi verification,
  and live-gateway E2E. It FAILS loudly if the JDK 17 / Android SDK toolchain is
  unreachable (required dependency, never a silent skip). CI **verifies** (compares
  against the committed goldens) — it does **not**
  record. So a UI change that isn't re-recorded + reviewed locally reddens CI on the drift.
  The local record-review loop is still yours: CI catches *drift from* a golden, but only a
  human/agent eyeballing a *newly recorded* golden catches a wrong first render.
- **`--rerun-tasks` to force a re-record.** When the test task is `UP-TO-DATE` (cached
  from a prior identical build) it won't re-execute and no PNGs are written. Add
  `--rerun-tasks`, or delete the golden dir first. (`scripts/android-render.sh` passes
  `--rerun-tasks` for you.)
- Capture path: tests write `src/test/roborazzi/<name>.png` (module-relative →
  `app/src/test/roborazzi/`, `feature-health/src/test/roborazzi/`) — a **tracked** dir so
  the goldens are committed and `verifyRoborazziDebug` has a baseline. The verify run's
  diff/actual/compare images go to the gitignored `build/outputs/roborazzi-compare/`.

### Emulator interaction (adb)

- **`adb input text` silently drops characters** on long or special strings (JSON, hex
  fingerprints). For anything non-trivial, type **per character** with keyevents
  (`adb shell input keyevent`: digits `0-9` → 7..16, `a-f` → 29..34). The host clipboard
  does **not** sync into the emulator, so paste isn't an option either.
- **Edge-swipe gestures collide with Android's system back-gesture.** A swipe that starts
  at the extreme screen edge (e.g. opening the citations drawer by swiping left from the
  right edge) is swallowed by the OS and navigates **out of the app** to the launcher.
  Start the swipe a little inset from the edge, or drive the in-app affordance directly
  (tap the sticky-tab pill).
- Standard loop: `adb install -r …/app-debug.apk` → `adb shell am force-stop
  <application-id>` → `adb shell am start -n <application-id>/dev.omnesis.android.MainActivity` →
  `adb exec-out screencap -p > shot.png`. Confirm focus with
  `adb shell dumpsys window | grep mCurrentFocus`.

### Networking

- The emulator reaches a gateway on the **host** at `10.0.2.2` (not `localhost`).
- It reaches a **Tailscale** gateway (e.g. a remote gateway host) directly at the tailnet IP —
  no `10.0.2.2` rewrite needed for those.
- The live gateway may **predate the `android` device-kind**; pair as `kind:"ios"` until
  the gateway is new enough to accept `android`.

### Build hygiene

- **Stale `* N.class` duplicates** (`Type X is defined multiple times`) fail the
  `assembleDebug` dex-merge (but not `compileDebugKotlin` or unit tests) after a killed
  Gradle run. Fix:
  ```bash
  ./gradlew clean
  find . -path '*/build/*' -regextype posix-extended -regex '.* [0-9]\.[a-z]+' -delete
  ```
- **Transient `R.jar` transform failures** (`Failed to transform R.jar … StructureTransformAction`)
  are stale-intermediate flakes, **not** code errors — a `./gradlew clean` clears them.

### Shell

- **`timeout` is not on macOS** (it's `gtimeout` from coreutils, often absent). Don't wrap
  Gradle in `timeout` — the command just errors "command not found" and Gradle never runs.
- **Piping Gradle to `tail`/`head` masks its exit code** — `$?` reflects the last pipe
  stage, not Gradle. A run can print `BUILD FAILED` yet the pipeline reports exit 0. Grep
  the captured output for `FAILED`/`BUILD`/`error:` instead of trusting the exit code, or
  don't pipe.

## Architecture

Modules: `:app` (Compose UI + ViewModels + Hilt root + nav), `:core-transport`
(Retrofit/OkHttp clients, wire DTOs, `DeviceSocket` WS, `AgentEventSource` SSE,
`LeafCertPinner`/`PinnedOkHttp`), `:core-pairing` (`PairingPayload`,
`PairingService`, `SecureStore`), `:core-designsystem` (`OmnesisTheme`,
`SourceCatalog`, atoms). MVVM + repository; Hilt DI; ViewModel + immutable
`StateFlow<UiState>`; OkHttp + Retrofit + kotlinx.serialization; Material 3 +
`ModalNavigationDrawer`. A `SessionManager` (the iOS `AppStore` analogue) rebuilds
the transport clients on pair/unpair/url-change.

## Conventions (carried from the repo)

- **Source encapsulation is sacred**: no source-specific branching/icons/colors/
  unit-nouns/deep-links in the client. Resolve everything from
  `/admin/source-descriptors` (the union across every online collector) via a
  single `SourceCatalog`. `SourceIcon.sfSymbol`
  is **iOS-only** — never map it to an Android drawable; resolve icons
  `imageDataUri → url → source-meta PNG → neutral fallback`.
- **Privacy**: never seed fixtures/previews from the user's corpus — invent fresh
  (`Maya Reeves`, `+1 (555) 010-0xxx`, `example.com`).
- **DTOs**: forward-compatible (`ignoreUnknownKeys`, sealed `Unknown` arms), hand-
  ported from the iOS `Codable` structs (the de-facto wire spec). Keep the gateway
  TS-type reference in a doc comment.
- **Logging**: tag `Omnesis:*`; structured one-liners.
