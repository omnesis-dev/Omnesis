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
