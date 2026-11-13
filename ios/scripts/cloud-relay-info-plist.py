#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Add the Info.plist entries only a cloud relay build needs.

Runs as a build phase on the processed Info.plist. With
OMNESIS_CLOUD_RELAY_ENABLED other than 1 it changes nothing, so the default
build's Info.plist carries neither entry. A usage description cannot be made
absent by a build setting (an empty string is still a present key), which is
why these are added here rather than written in the source plists.
"""

from __future__ import annotations

import os
import plistlib
import sys

LOCAL_NETWORK_KEY = "NSLocalNetworkUsageDescription"
LOCAL_NETWORK_TEXT = "Omnesis connects directly to your paired gateway on your local network when available."


def apply(info: dict, callback_scheme: str | None) -> dict:
    """Return `info` with the cloud relay entries. Safe to run twice."""
    info[LOCAL_NETWORK_KEY] = LOCAL_NETWORK_TEXT
    if callback_scheme:
        url_types = info.get("CFBundleURLTypes") or []
        if not url_types:
            raise SystemExit("Info.plist declares no URL types to add the sign-in callback scheme to")
        schemes = url_types[0].setdefault("CFBundleURLSchemes", [])
        if callback_scheme not in schemes:
            schemes.append(callback_scheme)
        info["CFBundleURLTypes"] = url_types
    return info


def main(arguments: list[str], environment: dict) -> None:
    if environment.get("OMNESIS_CLOUD_RELAY_ENABLED") != "1":
        return
    path = os.path.join(environment["TARGET_BUILD_DIR"], environment["INFOPLIST_PATH"])
    with open(path, "rb") as stream:
        raw = stream.read()
    binary = raw.startswith(b"bplist")
    # Only the app registers the callback scheme; extensions never open a URL.
    scheme = environment.get("OMNESIS_GOOGLE_CALLBACK_SCHEME") if "--callback-scheme" in arguments else None
    info = apply(plistlib.loads(raw), scheme)
    with open(path, "wb") as stream:
        plistlib.dump(info, stream, fmt=plistlib.FMT_BINARY if binary else plistlib.FMT_XML, sort_keys=False)


if __name__ == "__main__":
    main(sys.argv[1:], dict(os.environ))
