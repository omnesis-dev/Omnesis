# Android App Actions

Omnesis exposes two foreground actions through Google Assistant App Actions:

- **Ask Omnesis** creates a voice-profile agent session, waits for a bounded answer, speaks it,
  and lets the gateway deliver a slow-answer notification when the turn outlives the foreground
  window.
- **Tell Omnesis** captures a note through the same durable offline queue as the launcher shortcut
  and Quick Settings tile.

Android's supported integration is App Actions. Conversational Actions are discontinued, so the
assistant launches Omnesis's exported fulfillment activity and Omnesis owns missing-parameter
dictation, progress, result UI, and text-to-speech. Phrases are suggestions rather than an exact
grammar. Deterministic custom-intent forms include “Hey Google, open Omnesis and ask …” and “Hey
Google, open Omnesis and remember …”. Shorter Siri-like forms are not guaranteed. Gemini routing
is device-dependent and is not part of the App Actions compatibility contract until Google
documents or Omnesis verifies it on that surface.

The declarations live in `android/app/src/main/shortcuts/shortcuts.xml`, a template the build
writes to `res/xml/shortcuts.xml` with the package id as a literal `android:targetPackage` (Google
Play rejects a resource reference there). Built-in
`OPEN_APP_FEATURE`, `GET_THING`, and `CREATE_THING` capabilities provide broad matching, while
US-English (`en-US`) custom intents bind question/note text directly and require the device's
Assistant language to match. Ask and capture open
`AssistantActionActivity`; `GET_THING` opens the ordinary Search destination with the extracted
query. No background receiver mutates or reads private data invisibly.

App Actions does not provide a signature permission that only Google's assistant holds. The
fulfillment Activity therefore has to be exported and another installed app can explicitly open
it with the declared action strings. Omnesis accepts immediate parameter fulfillment only when
Android 15 or newer identifies an allow-listed Google assistant package for that exact delivery
and its signature matches Google Play services. Older Android versions and unknown callers must
cross a visible confirmation boundary before supplied text is sent or saved. Input is bounded
before use, and `FLAG_SECURE` plus exclusion from Recents keeps private
answers out of task snapshots and screen capture. Spoken answers use only a TTS voice that the
engine declares offline; when none exists, the answer remains visible and silent. Do not move
fulfillment into an exported receiver or service.

Voice ask and capture are generally available. Their App Action metadata is registered when
Android installs the app. Capture preserves a note in the phone's durable queue whenever its
paired gateway is temporarily unreachable, then retries when connectivity returns.

## Testing and Play availability

Run the focused logic and resource contract tests first, then the Roborazzi render lane described
in `android/AGENTS.md` and inspect every assistant PNG. An installable build still needs Google to
recognize its App Actions metadata. Unapproved App Actions on internal or closed tracks require
the tester's Google Account to belong to the App Actions Development Program group; propagation
can take up to three hours. The same account must be used in Play Console, Android Studio, and the
Google app on the test device. Accepting the App Actions terms is required before publishing a
release that contains actions; production discovery additionally requires Google's separate App
Actions review. These controls are independent of APK installation and Omnesis's internal-testing
release track.

A physical device or emulator can validate the generated fulfillment intents. Robolectric and
Google's App Actions Test Library validate the `shortcuts.xml` mapping and Omnesis destination;
direct ADB launches validate only Omnesis's destination handlers. None of these prove Google's
speech recognition, query matching, or capability discovery. A complete
recognition test needs a Google Play-enabled device with full Google Assistant configured; Google
Assistant Go explicitly does not support App Actions, and Gemini Go support is undocumented. The
current Android Studio Assistant plugin may also lag new Android Studio releases, so the automated
resource/fulfillment tests remain the stable local contract when the preview tool is unavailable.
