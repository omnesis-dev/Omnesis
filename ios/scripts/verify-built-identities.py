#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Check processed bundle metadata in an unsigned iOS simulator build."""

import plistlib
import sys
from pathlib import Path


def read_plist(bundle: Path) -> dict:
    with (bundle / "Info.plist").open("rb") as stream:
        return plistlib.load(stream)


def expect(actual: object, wanted: object, label: str) -> None:
    if actual != wanted:
        raise SystemExit(f"{label}: expected {wanted!r}, got {actual!r}")


products = Path(sys.argv[1])
base = sys.argv[2]
app = products / "Omnesis.app"
info = read_plist(app)
expect(info["CFBundleIdentifier"], base, "app bundle ID")
expect(
    info["BGTaskSchedulerPermittedIdentifiers"],
    [f"{base}.refresh", f"{base}.photosBackfill", f"{base}.backfill"],
    "app background task IDs",
)

for name, suffix in (
    ("OmnesisNotificationService", "notification-service"),
    ("OmnesisWidgets", "widgets"),
):
    extension = app / "PlugIns" / f"{name}.appex"
    expect(read_plist(extension)["CFBundleIdentifier"], f"{base}.{suffix}", name)

watch = app / "Watch" / "OmnesisWatch.app"
watch_info = read_plist(watch)
expect(watch_info["CFBundleIdentifier"], f"{base}.watchkitapp", "Watch bundle ID")
expect(watch_info["WKCompanionAppBundleIdentifier"], base, "Watch companion ID")
expect(
    read_plist(watch / "PlugIns" / "OmnesisWatchWidgets.appex")["CFBundleIdentifier"],
    f"{base}.watchkitapp.widgets",
    "Watch complications bundle ID",
)

app_group = info["OmnesisKeychainAccessGroup"]
extension_group = read_plist(app / "PlugIns" / "OmnesisNotificationService.appex")[
    "OmnesisKeychainAccessGroup"
]
expect(extension_group, app_group, "app and notification extension Keychain group")
if not app_group.endswith(f"{base}.notifications"):
    raise SystemExit(f"Keychain group does not end in {base}.notifications: {app_group!r}")

# Every build reaches its gateway on the home network and signs in to the cloud
# account through the browser, so the app and both extensions explain local
# network use and the app also registers the Google callback scheme: the
# reversed client ID it was built with.
bundles = {"app": info}
for name in ("OmnesisNotificationService", "OmnesisWidgets"):
    bundles[name] = read_plist(app / "PlugIns" / f"{name}.appex")
for label, plist in bundles.items():
    expect(bool(plist.get("NSLocalNetworkUsageDescription")), True, f"{label} local network usage text present")
schemes = [scheme for entry in info.get("CFBundleURLTypes", []) for scheme in entry.get("CFBundleURLSchemes", [])]
client_id = info.get("OmnesisGoogleClientID", "")
callback = ".".join(reversed(client_id.split(".")))
expect(callback.startswith("com.googleusercontent.apps."), True, "Google client ID is an iOS OAuth client")
expect(schemes, ["omnesis", callback], "app URL schemes")
expect(info.get("OmnesisCloudRelayURL", "").startswith("https://"), True, "cloud relay URL is HTTPS")

print(f"Verified processed app, extension, widget and Watch identities for {base}")
