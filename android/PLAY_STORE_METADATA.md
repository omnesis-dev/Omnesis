# Omnesis Android — Google Play metadata

Draft copy and release-asset requirements for the `playRelease` artifact. The
Google Play edition deliberately omits the Call Log source and
`android.permission.READ_CALL_LOG`; the full, self-built edition is not the
artifact described here.

## Main store listing

| Field | Value |
| --- | --- |
| App name | `Omnesis` |
| Short description | `Search your personal data through a gateway you control.` |
| Category | Productivity |
| Tags | Personalization; Productivity |
| Support URL | `https://omnesis.dev/docs/apps#support` |
| Marketing URL | `https://omnesis.dev` |
| Privacy policy URL | `https://omnesis.dev/mobile-privacy-policy` |
| Contact email | `contact@omnesis.dev` |

### Full description

```text
Omnesis is a personal data index and assistant connected to an Omnesis gateway you control.

Pair the app with your gateway over HTTPS, then search and explore your indexed information, ask questions with the gateway's configured agent, capture notes, and receive private notifications. Notification text stays on the gateway: Firebase Cloud Messaging carries a fixed, content-free wake, and the app retrieves the notification directly from the paired gateway.

You can optionally add information from this Android device:

• Health Connect records from categories you select
• App-usage statistics
• On-device text and labels extracted from selected photos and screenshots
• Physical-activity segments

After pairing, a setup flow walks through each source this phone can add: what it makes searchable, what is sent to your gateway, and what stays on the phone. Each source is off until you choose it there or in Settings and approve the relevant Android permission or special access; everything in setup can be changed later in Settings. The app reads Health Connect data only; it never writes health records. Photo pixels remain on your device—the app sends only extracted text, labels, timestamps, and optional location metadata to your gateway.

Omnesis has no advertising, analytics, or tracking SDKs and does not require an Omnesis account. The gateway can run on hardware you operate or be supplied by an organization you trust. If the gateway operator enables a cloud inference provider, the inputs required for that configured role are sent to that provider under its terms.

Requirements:

• Android 8.0 or later
• An Omnesis gateway reachable at an HTTPS address

Learn how to set up and operate a gateway at omnesis.dev/docs.
```

## Release assets

Keep generated Play assets under `android/store-listing/en-US/`:

- `icon.png`: 512 × 512, 8-bit-per-channel RGBA PNG.
- `feature-graphic.png`: 1024 × 500 PNG or JPEG.
- `phone-screenshots/`: at least four portrait screenshots from the Play flavor,
  using only invented data. Recommended surfaces are onboarding, search results,
  the agent answer, and connected Settings.

Before uploading, inspect every image, confirm that no Call Log surface appears,
and run `./gradlew :app:verifyPlayReleasePolicy :app:bundlePlayRelease`.

Suggested screenshot alternative text (each is under 140 characters):

| Asset | Alternative text |
| --- | --- |
| `01-onboarding.png` | `Omnesis onboarding explains private search through a paired personal gateway.` |
| `02-search.png` | `Search results for an invented budget query show matching notes and files.` |
| `03-agent.png` | `The Omnesis agent answers an invented budget question and cites its source note.` |
| `04-people.png` | `The People screen groups invented contacts and shows their indexed document counts.` |
| `05-settings.png` | `Connected Settings show appearance, gateway controls, and the privacy policy link.` |
