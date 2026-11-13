# Omnesis Android

Build the Android app from this checkout with JDK 17, the Android SDK, and the committed Gradle wrapper. The `full` edition includes Call Log for sideloading; the `play` edition omits it.

## Build and install on your phone

1. Choose an Android package id you control, such as `dev.example.omnesis`. Keep it for later updates. A separately signed build using the official package id cannot update the store app or coexist with it. The build's Kotlin namespace stays `dev.omnesis.android`; only the installed app identity changes.
2. For background notifications, register that exact package id as an Android app in your Firebase project. Obtain its Firebase application ID, API key, project ID and sender ID, and a service account for sending FCM messages. Run `omnesis push setup` from a machine that has this Android checkout, select Android, and enter the same package id. The service-account path must exist on the CLI machine and be readable at the same path by the gateway host; running the wizard on the gateway host with the checkout accessible there is simplest. Give the wizard the Android project directory. It configures the gateway and writes `android/local.push.properties` in that checkout with the package id and Firebase client values. If you do not need background notifications, create that ignored file yourself with only `OMNESIS_ANDROID_APPLICATION_ID=dev.example.omnesis`.
3. Build and install the debug APK:

   ```sh
   cd android
   ./gradlew :app:assembleFullDebug
   adb install -r app/build/outputs/apk/full/debug/app-full-debug.apk
   ```

4. Pair the installed app with your gateway using `omnesis devices pair --kind android`. For push, open the app, grant notification permission when asked, check Settings → Notifications, and run `omnesis push test --device <name-or-id>`. Test while the app is in the background; a foreground socket notification does not prove FCM delivery.

`local.push.properties` is gitignored and must stay out of commits. A Firebase service account is a gateway credential and does not belong in the Android build. The wizard passes its file path to the gateway, which must be able to read it; the CLI does not upload a file from your laptop. Changing the package id creates a different app with separate local data and pairing. Changing Firebase client values requires a rebuild; changing gateway credentials can be rechecked with Retry in the app. If Firebase settings are absent or the gateway does not cover this package id, Settings → Notifications shows which side needs setup.

The app uses the shared `omnesis://` URI scheme for some links. When two Omnesis builds coexist, Android may ask which app should open such a link; open the intended app directly if needed.

See the [Notifications guide](https://omnesis.dev/docs/notifications#setup) for FCM setup, status and repair.

## Wear OS app

The `:wear` module is the watch app, and `:wear-core` its logic, a plain JVM
library whose tests (`./gradlew :wear-core:test`) need no Android toolchain. The
app relays through the phone app, so build and install both from the same
checkout with the same package id and signing key; the watch app reads its
package id and version from the phone app's build.

```sh
cd android
./gradlew :wear:assembleDebug
adb -s <watch-serial> install -r wear/build/outputs/apk/debug/wear-debug.apk
```

Open Omnesis from the watch's app list, or add the **Omnesis** tile or
complication to open the recorder from the watch face.

## Task widgets

Add **Omnesis → Tasks** from the launcher's widget picker, then resize it to fit.
The widget adapts from compact to wide layouts and offers day, week and month
browsing, task pages and completion buttons. Each widget has independent
navigation. Tap a task title to open its details in the app.

`app/.../widgets/` owns the native RemoteViews renderer, private action receiver,
WorkManager refreshes, date projection and compact encrypted snapshot cache.
Widgets read the app's existing pairing through `PairingService` and use the same
HTTPS trust policy and Tasks client. Rendered actions carry an opaque pairing
authority digest, so a checkbox from a previous pairing cannot act on the new
one. The cache is sealed with the Android Keystore and invalidated when the
pairing changes; credentials are never copied into widget metadata or worker
inputs. A failed completion leaves the task open.

`TaskWidgetScreenshotTest` renders the actual RemoteViews in compact, medium,
large and tablet sizes, including light/dark and offline/empty/error states.

## Wear OS watch relay

A paired Wear OS watch running Omnesis holds no gateway credentials. It hands
questions, notes and recordings to this phone app over the Wearable Data Layer,
and the phone app asks the gateway with its own pairing. The contract both apps
share (paths, messages and the policies each end applies) is the plain-JVM
`:core-wear-protocol` module.

`app/.../wear/` is the phone side. `WearRelayService` receives what the watch
sends, with the app not running if need be, and hands it to `WearRelay`, which
routes to one orchestrator per job: publishing the gate that tells the watch
which buttons to show, answering a text question, saving a text note, acting on
relays the watch queued, and turning a recording into a note or an answered
question. A recording is copied into a no-backup inbox before the watch is told
the phone has it, and stays there until it is processed. Relay work is held
alive by expedited WorkManager work, since the listener service is bound only
for its callbacks. Settings → Watch shows the watch's connection, the gateway's
decision-gate setting and what on-device transcription needs.

The relay needs Google Play services' Wearable API. Without it nothing is
started and the Watch section is hidden.

The phone app's unit tests include loopback tests (`app/src/test/.../wear/loopback/`)
that run the watch's real logic against this relay over an in-memory Data Layer,
so the two sides are tested against each other and not only against the contract.

## Optional Google pairing through the experimental relay

QR and manual pairing remain available without Google. A configured build may
also offer Google sign-in using Credential Manager. Supply these public Gradle
properties or environment variables (the ignored `local.push.properties` may
also hold them):

```properties
OMNESIS_GOOGLE_WEB_CLIENT_ID=fictional-web.apps.googleusercontent.com
OMNESIS_GOOGLE_ANDROID_CLIENT_ID=fictional-android.apps.googleusercontent.com
OMNESIS_CLOUD_RELAY_URL=https://relay.example.test
```

Register the Android OAuth client for the application ID and signing-certificate
fingerprint. The web client is the ID-token audience; the Android client is an
explicitly trusted authorized presenter. Configure both on the gateway and relay
as well. The app uses public identifiers and contains no OAuth client secret.

Google identifies the requesting account and discovers a gateway candidate.
The app independently verifies Google's signature and computes a six-digit
comparison code locally (shown as `465 774`). The gateway commits to its random
part of the code before the phone sends its secret, and the phone shows a code
only when the gateway's reply opens that commitment and carries the same code
the phone computed; otherwise pairing stops without showing one. Compare it on
the gateway's **local** portal or trusted terminal, or under Devices → Pairing
requests on a phone that is already paired, then approve the device there and
confirm the match on the phone.
An operator-controlled public hostname is not an independent place to compare
codes against that operator. A relay approval alone never persists a device
credential; only the gateway's own checks can skip the comparison (below).

The initial certificate comparison authenticates a separate SHA-256 pin of the
gateway's complete DER SubjectPublicKeyInfo. That key stays strictly pinned
across HTTP, WebSocket, notifications and task widgets. Current certificate
validity and the canonical hostname are checked; same-key certificate renewal
works without adopting public certificate trust. A changed gateway key requires
a fresh trusted pairing. Existing exact certificate pins retain their original
behavior and are never silently reinterpreted as key pins.

Sign-in enrollment (`docs/device-enrollment.md`) also lets a trusted sign-in join a
device without the comparison, when the gateway's own setting allows it. On first
contact the app checks that the proposed certificate is publicly trusted and logged;
a certificate that isn't asks the gateway to hold the request for approval. Set
`OMNESIS_CLOUD_RELAY_PUBLIC_CERT_CHECK=0` to skip that check for a test gateway in a
debug build; a release build always checks, and `:app:verifyPlayReleasePolicy` fails if
it would not.
Without `OMNESIS_CLOUD_RELAY_ENABLED=1` none of this exists in the build: no key,
settings, device details, notifications or token rotation.
The same value decides whether the sign-in libraries are packaged: the code that
needs them lives in `app/src/cloudRelay` and joins the app only when it is set.
Otherwise the app's manifest gains nothing from them, a QR naming a strict trust
mode is refused as unknown, and the tests alone compile that code.
