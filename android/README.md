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
The app independently verifies Google's signature and computes a certificate
comparison code locally. Compare it on the gateway's **local** portal or trusted
terminal, then approve the device there and confirm the match on the phone.
An operator-controlled public hostname is not an independent place to compare
codes against that operator. Neither sign-in nor remote approval alone can
persist a device credential.

The initial certificate comparison authenticates a separate SHA-256 pin of the
gateway's complete DER SubjectPublicKeyInfo. That key stays strictly pinned
across HTTP, WebSocket, notifications and task widgets. Current certificate
validity and the canonical hostname are checked; same-key certificate renewal
works without adopting public certificate trust. A changed gateway key requires
a fresh trusted pairing. Existing exact certificate pins retain their original
behavior and are never silently reinterpreted as key pins.
