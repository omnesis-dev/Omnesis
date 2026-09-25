# Notification service extension simulator spike

The notification wake design depends on one empirical property: after a service
extension claims rendered content, do changes to `interruptionLevel` and `badge`
survive delivery? `scripts/ios-push-spike.sh` builds and signs the real app and
extension, installs them in a simulator, grants notification permission, sends the
constant wake with `simctl push`, and inspects the delivered notification from the
app's data container.

## Current toolchain result

With Xcode 26.2 and the iOS 26.3 simulator runtime, the test is blocked before the
property under test. The signed extension is embedded, its deployment target
matches the app, its Info.plist and simulated entitlements are valid, and PlugInKit
registers it. Nevertheless, the simulator log records `CoreSimulatorBridge`
adding the payload directly as a notification request. No extension process starts,
the isolated claim fixture receives no request, and the delivered title and body
remain the constant placeholder at the default interruption level.

That observation is neither the positive nor the negative product branch. A valid
negative requires proof that the extension claimed, confirmed, and rewrote the
content before the system discarded either the interruption level or badge. The
spike classifier enforces that distinction.

## Reproduction and next proof

Run:

```sh
OMNESIS_EPIC_MACOS_HOST=<host> \
OMNESIS_IOS_DEVELOPMENT_TEAM=<team-id> \
scripts/ios-push-spike.sh
```

The harness reports one of three results:

- `positive`: claim, confirmation, rewrite, interruption level, and badge survived.
- `negative`: the extension completed, but interruption level or badge did not survive.
- `blocked`: separate-extension completion was not proven. When the simulator used
  the local-request path, `simulatorBridgeInjectedRequest` is `true`.

Do not choose a payload branch from `blocked`. The remaining decisive test is the
same signed build receiving a real sandbox APNs notification on a physical device,
or a simulator runtime known to route `simctl push` through the remote-notification
service-extension pipeline.
