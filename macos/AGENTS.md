# macOS development

Follow the root agent contract. Read `README.md` here and `../docs/desktop.md`
before changing the desktop application or its runtime boundary.

- Keep enrollment, lifecycle and resource policy in the portable desktop runtime.
  Swift owns presentation and native OS adapters. Provider descriptors own all
  source-specific behavior.
- Run the pure `DesktopCore` tests before the application build and GUI tests.
  Native checks use admitted native infrastructure or GitHub-hosted macOS CI.
- Render affected SwiftUI states, inspect the images and fix the render before
  handoff. Include populated, loading, empty, offline and error states; a
  missing-runtime screen does not validate the functional application.
- Tests use isolated invented data, named local services and scripted chat
  backends. They must never start a production account connection.
- Manage only the application's owned state and child processes. A headless
  installation is independent, even when both installations run on one Mac.
