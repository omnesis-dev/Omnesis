# Omnesis iOS — App Store Connect metadata

Submission-ready English (U.S.) copy for version 0.3.0. Keep App Store Connect
answers aligned with the release binary and
[`mobile-privacy-policy.html`](../website/mobile-privacy-policy.html).

## App information

| Field              | Value                   |
| ------------------ | ----------------------- |
| App name           | `Omnesis`               |
| Subtitle           | `Your life, searchable` |
| Primary category   | Productivity            |
| Secondary category | Health & Fitness        |
| Price              | Free                    |
| Copyright          | `2026 Adrien Conrath`   |

Complete the age-rating questionnaire from the shipping features; do not copy a
hard-coded rating from this document.

## Version 0.3.0

### Promotional text

```text
Search your personal knowledge, ask questions with context, capture notes, and sync selected phone data to a gateway you control.
```

### Description

```text
Omnesis is the mobile companion for a personal-knowledge gateway you control.
Pair the app with your gateway to search your indexed information, ask questions
with context, capture notes, and receive private notifications.

On iPhone and Apple Watch:
• Ask the Omnesis assistant by typing or speaking.
• Capture a note from the app, Siri, Control Center, or Apple Watch.
• Search documents and browse people, sources, briefs, and conversations.
• Receive content-free notification wakes, then retrieve the actual notification
  directly from your paired gateway.
• Optionally sync selected Apple Health, motion activity, photo text and
  metadata, and location visits.

You stay in control:
• There is no Omnesis account.
• The app contains no advertising, analytics, or tracking SDKs.
• Mobile connections require HTTPS.
• Health access is read-only and category-by-category.
• Photos remain on your device; only extracted text and metadata are sent.
• Phone sources are off until you enable them and can be disabled at any time.
• Cloud inference is off by default. If your gateway operator enables it, the
  selected provider processes the inputs needed for that model role.

Requirements:
• iOS 17 or later.
• A reachable Omnesis gateway with HTTPS configured.

Setup instructions are available at https://omnesis.dev/docs/setup.
Privacy policy: https://omnesis.dev/mobile-privacy-policy.
```

### Keywords

```text
personal knowledge,search,assistant,notes,health,photos,self hosted,privacy,second brain
```

### URLs

| Field              | URL                                         |
| ------------------ | ------------------------------------------- |
| Marketing URL      | `https://omnesis.dev`                       |
| Support URL        | `https://omnesis.dev/docs/apps#support`     |
| Privacy policy URL | `https://omnesis.dev/mobile-privacy-policy` |

## Screenshots

The production target supports iPhone and iPad and embeds an Apple Watch app, so
the submission needs one consistent set for each family. Apple accepts one to ten
images per set and scales the highest-resolution required set to smaller devices.

Run `scripts/generate-ios-app-store-screenshots.sh`. It produces synthetic-data
captures under `ios/AppStoreAssets/screenshots/` at these accepted sizes:

- iPhone 6.9-inch portrait: 1320 × 2868
- iPad 13-inch portrait: 2064 × 2752
- Apple Watch: 410 × 502

The deterministic phone/tablet shot list is:

1. Ask — populated assistant conversation.
2. Search — search and result context.
3. People — people graph/list.
4. Privacy controls — Settings, source controls, and the in-app privacy policy.

The Watch set shows the idle Ask surface and a completed answer.

Inspect every generated PNG for synthetic-only content, layout, status-bar
cleanliness, alpha, and exact dimensions before upload. The script validates
dimensions and fails if an expected file is absent.

## Privacy manifest and App Privacy answers

Apple defines collection as data transmitted off-device in a way that lets the
developer or a third party access it beyond what is needed to service the
request in real time. User-selected corpus, Health, Photos, and Places data goes
only to the HTTPS gateway the user pairs and controls; Omnesis does not receive
it. Those categories therefore remain absent from
`NSPrivacyCollectedDataTypes` and should be answered consistently in App Store
Connect.

The Omnesis-operated notification relay does retain a device's APNs carrier
token for app functionality. The app manifest therefore declares Device ID as
linked, not used for tracking, and used for App Functionality. The store-review
gateway contains synthetic data only, so it does not change these answers.
