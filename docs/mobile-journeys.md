# Mobile UI journeys

`scripts/run-mobile-journeys.sh` opens the iOS or Android app and drives its
main journeys the way a person does — launch, tap, type, read what appears —
against a real gateway serving invented data. The unit, snapshot and Roborazzi
suites check pieces of each app in isolation, and the live-gateway transport
tests check that the apps decode real responses; the journeys are the one place
where a tap on a real screen has to reach the gateway and come back as
something on screen.

## What they cover

| Journey          | What the test does                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pairing          | Starts unpaired, taps _Pair with your gateway_, gets past the camera (no camera on a simulator; the Android test declines the permission), pastes the QR payload the gateway minted, checks the confirmation names the gateway, confirms. It passes when phone setup shows _Connection verified_ and the gateway lists the new device, then skips setup and lands on the Ask screen. |
| Search           | Opens the menu, picks Search, types `Acme Q3 Planning` and waits for that document in the results.                                                                                                                                                                                                                                                                                   |
| Open a document  | The search above, then a tap on the result; passes when the document's text (`Draft the migration plan by Friday`) is on screen.                                                                                                                                                                                                                                                     |
| Ask the agent    | Types `Where was I on September 2?` on the Ask screen and sends it; passes when the answer names `Studio Northstar`.                                                                                                                                                                                                                                                                 |
| Notification tap | iOS only, from the existing `PushTapUITests`: a gateway push payload enters the app's notification delegate and must land on its destination.                                                                                                                                                                                                                                        |
| Agent scrolling  | iOS only, from the existing `AgentScrollUITests`: the scroll-to-latest control reaches the end of a long conversation.                                                                                                                                                                                                                                                               |

The document and the conversation come from the `default` universe
(`evals/universes/default/`, see `docs/universes.md`): the Granola note _Acme
Q3 Planning_ and the replay scenario `temporal-recall`. The agent's answer is a
recorded scenario replayed by the gateway's replay backend, so no model runs.
The only model involved is the embedding model the gateway needs to index the
corpus for `POST /search`.

Each journey is independent. Pairing starts from an app with no stored
credentials. The others start paired: on iOS through the DEBUG launch seam
(`DEMO_PAIRING_JSON`), on Android through the DEBUG `seed_*` launch extras,
which run the real pairing exchange with a code the test mints. Android runs
each test in its own instrumentation with the app's data cleared (the test
orchestrator), so a failed journey leaves nothing behind for the next.

Adding a phone source (Apple Health, Health Connect, …) is not a journey yet:
each one ends in an operating-system permission sheet — Health Connect's
cannot be granted from a test at all (`android/AGENTS.md`) — so it needs its
own design. The Android app has no notification-tap journey yet either.

## How the tests find things

Tests locate controls by accessibility identifier on iOS
(`.accessibilityIdentifier`) and by test tag on Android (`Modifier.testTag`),
never by position. The identifiers are named after what the control is for and
are shared between the platforms where the control exists on both:

| Identifier                                              | Control                                              |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `onboarding.pair`                                       | _Pair with your gateway_ on the first screen         |
| `pairing.moreOptions` (iOS), `pairing.manual` (Android) | the way from the scanner to manual entry             |
| `pairing.pasteJSON.field`, `pairing.pasteJSON.submit`   | the pairing-payload field and its Pair button        |
| `pairing.confirm`                                       | Pair on the confirmation sheet                       |
| `phoneSetup.choose`, `phoneSetup.skip`                  | _Choose what to add_, _Skip for now_                 |
| `menu.toggle`, `menu.<destination>`                     | the menu button and each menu row (`menu.search`, …) |
| `search.field`, `search.result`                         | the search box and each result row                   |
| `agentComposer`, `agentSendButton`                      | the Ask composer and its Send button                 |

Renaming or removing one of these breaks a journey on purpose. Change the
identifier and the test together.

## Running them locally

Both platforms boot the gateway themselves, on port 17720 with its state under
`/tmp/omnesis-mobile-journeys/`, and stop it when they finish. Neither touches
any other gateway.

**iOS** needs macOS with Xcode 26, XcodeGen and an `iPhone 17` simulator
(override with `OMNESIS_JOURNEY_IOS_SIMULATOR`):

```bash
scripts/run-mobile-journeys.sh ios
OMNESIS_JOURNEY_ONLY=MobileJourneyUITests/testAskingTheAgentShowsItsAnswer scripts/run-mobile-journeys.sh ios
```

**Android** needs an emulator already running (the journeys reach the gateway
on the host at `10.0.2.2`), JDK 17 and the Android SDK:

```bash
emulator -avd <your-avd> -no-snapshot &
adb wait-for-device
scripts/run-mobile-journeys.sh android
OMNESIS_JOURNEY_ONLY=MobileJourneyTest#searchListsAMatchingDocument scripts/run-mobile-journeys.sh android
```

The first run on a machine without `~/.config/omnesis/models/` downloads the
embedding model (about 150 MB) into `~/.cache/omnesis-journeys/` and checks its
SHA-256.

A failed journey is retried once (`OMNESIS_JOURNEY_RETRIES=0` turns that off).
After a failure, `/tmp/omnesis-mobile-journeys/artifacts/` holds a screen
recording of the whole run, the failure screenshots (inside the `.xcresult`
bundle and exported to `failure-attachments/` on iOS; `failure-screenshots/`
on Android, with the Compose semantics tree in `logcat.txt` under the
`OmnesisJourney` tag), the test reports and the gateway's logs.

## In CI

`.github/workflows/mobile-journeys.yml` runs both platforms on every push to
`main` and on manual dispatch, and on pull requests that change the
corresponding app or the shared machinery (the journey script, the demo
gateway scripts, the `default` universe, the workflow). The iOS lane uses one
`macos-26` runner; the Android lane boots an API 34 emulator with KVM on
`ubuntu-latest`. Neither needs a secret.

The lanes are not part of `full-validation`, so the README badge keeps
reporting the full suite alone. On failure, the job uploads everything listed
above as the `ios-journeys` or `android-journeys` artifact.
