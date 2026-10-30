# Omnesis iOS — TestFlight and App Store release guide

This public checklist covers source-side validation and the non-secret release
contract. Never commit signing material, store credentials, or reviewer access
details.

## Release contract

- Production bundle: `dev.omnesis.ios`.
- App Store version: the product version in `packages/cli/package.json`, aligned
  with `MARKETING_VERSION` in `project.yml`.
- Every upload uses a strictly increasing integer build number. Confirm App
  Store Connect has no equal or higher build before uploading.
- iOS and iPadOS 17 or later; iPhone and iPad device families.
- Embedded targets: notification service, Control Center widget, and Apple Watch
  companion with its complications extension.
- Every mobile gateway URL is HTTPS. The app has no ATS arbitrary-load exception.
- HealthKit is read-only and optional.

## Before creating an archive

1. Read `docs/releasing.md` and this file.
2. Confirm `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` agree in
   `project.yml`, `Info.plist`, and `Info-Demo.plist`.
3. Regenerate the project: `cd ios && xcodegen generate`.
4. Run the SwiftPM logic lane, simulator snapshot suite, live-gateway transport
   suite, and a Release archive validation.
5. Generate the store screenshots with
   `scripts/generate-ios-app-store-screenshots.sh` and inspect every PNG.
6. Confirm the archive contains:
   - `PrivacyInfo.xcprivacy` in the app and every embedded executable bundle;
   - no `NSAllowsArbitraryLoads` key;
   - no `WebRTC.framework` in the production app or any bundle it embeds;
   - HealthKit, notification, widget, and Watch entitlements expected for their
     respective targets;
   - the intended product version and build number.
7. Compare App Store privacy answers with the bundled privacy manifest, the
   shipping behavior, and `website/mobile-privacy-policy.html`.

## Device smoke test

Physical-device tests are an operator step. Before review, validate the exact
candidate build from TestFlight:

- scan an HTTPS V4 pairing QR and pair successfully;
- use the Paste JSON fallback;
- ask the agent and receive an answer;
- capture a note from the app and Siri;
- tap the Omnesis Watch complication, record, and test Ask, Tell, and automatic Send;
- verify answers, manual playback, audio-only follow-ups, and Cancel returning to the watch face;
- receive a content-free APNs wake and retrieve its content from the gateway;
- enable selected HealthKit categories, sync, and confirm buffer drain;
- deny HealthKit, Camera, Location, Photos, Motion, Microphone, Speech, and
  Notifications individually and confirm the rest of the app remains usable;
- open Settings → About and confirm the version and build match the uploaded build;
- open Settings → About → Privacy Policy;
- verify iPhone, iPad, and Apple Watch layouts on supported hardware where
  available.

## Archive and upload

Archive, export, and upload the exact validated commit using a repeatable signed
release process. Record the uploaded build and do not hand-upload an unrelated
local archive or reuse a build number.

For a local diagnostic archive only:

```sh
cd ios
xcodegen generate
xcodebuild archive \
  -project Omnesis.xcodeproj \
  -scheme Omnesis \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath /tmp/Omnesis.xcarchive
```

Signing and provisioning values come from the operator's ignored local config
and Apple account; they are never committed.

## Export compliance

The production app (`Omnesis`, `dev.omnesis.ios`) and every bundle it embeds use
only encryption provided by Apple's operating system: HTTPS through
`URLSession`, Keychain, and CryptoKit. It links no third-party cryptography —
its only package, SwiftDraw, renders SVG — and has no ATS arbitrary-load
exemption. Realtime voice, whose WebRTC framework implements DTLS/SRTP through
BoringSSL, builds only into the demo app, so the production target neither links
nor embeds WebRTC. Its `Info.plist` therefore sets
`ITSAppUsesNonExemptEncryption` to `false`: the build is exempt and App Store
Connect asks no export-compliance questions for it. Before an upload, confirm
the archive still has no `WebRTC.framework` in any bundle and that the target's
dependencies are unchanged.

The demo app (`OmnesisDemo`) still bundles WebRTC and BoringSSL, so its
encryption is not limited to Apple's operating system. `Info-Demo.plist` omits
`ITSAppUsesNonExemptEncryption` so App Store Connect asks its current
export-compliance questions for each demo build. Review that archive, including
linked third-party libraries, against
[Apple's export compliance requirements](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption/).
Apple distinguishes standard algorithms implemented outside its operating system
and requires a French encryption declaration when distributing such an app on the
App Store in France; do not assume standard encryption is automatically exempt.
Complete that determination for the intended distribution and obtain any
requested documentation before making a demo build available to testers.

## TestFlight

After processing:

1. Confirm the build reports the intended product version and build number.
2. Confirm the production build reports its exempt encryption answer; complete
   any export-compliance prompt for a demo build.
3. Add the exact build to the internal group.
4. Install it through TestFlight and run the physical-device smoke test above.
5. Do not promote a different build to App Review after testing; the reviewed
   binary, gateway compatibility, privacy answers, screenshots, and notes must
   describe one exact commit.

Suggested internal-testing note:

```text
Pair with an HTTPS Omnesis gateway, then test search,
assistant questions, note capture, notifications, optional phone sources, and
the privacy-policy link in Settings. Please report the build number and the
screen/permission state with any issue.
```

## App Review

Use the customer-facing metadata in `APP_STORE_METADATA.md`. In App Store
Connect:

- mark the app as restricted because pairing requires an action on another
  device;
- provide complete, non-expiring access instructions and credentials in the
  protected sign-in fields, never in this repository;
- explain QR and JSON pairing and optional permissions in the review notes;
- attach the generated iPhone, iPad, and Apple Watch screenshot sets;
- select the exact TestFlight-validated build;
- complete HealthKit, age-rating, privacy, content-rights, export-compliance,
  and availability forms from the shipping behavior.

Submitting the version for App Review is always an explicit operator action.

## Common failures

- **Build cannot be selected for the release:** the binary's marketing version
  does not match the App Store version record.
- **Invalid privacy manifest:** inspect every bundled `PrivacyInfo.xcprivacy`;
  only Apple-defined keys, categories, reasons, and purposes are accepted.
- **Required-reason API warning:** generate Xcode's privacy report from the
  archive and reconcile it with the app manifest.
- **HealthKit usage description missing:** inspect the archived app's Info.plist,
  not only the source plist.
- **Insecure connection or ATS failure:** the pairing URL must be HTTPS. Create a
  fresh V4 pairing code after enabling gateway TLS.
- **Reviewer cannot enter the app:** verify the supplied access instructions and
  test both QR and Paste JSON paths before submitting.
