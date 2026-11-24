// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = `
import plistlib, subprocess, sys, tempfile
from pathlib import Path

root, base, mutation = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
with tempfile.TemporaryDirectory(prefix="omnesis-built-identities-") as temporary:
    products = Path(temporary)
    app = products / "Omnesis.app"
    with (root / "ios/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    info["CFBundleIdentifier"] = base
    info["BGTaskSchedulerPermittedIdentifiers"] = [
        value.replace("$(PRODUCT_BUNDLE_IDENTIFIER)", base)
        for value in info["BGTaskSchedulerPermittedIdentifiers"]
    ]
    if mutation == "missing":
        info["BGTaskSchedulerPermittedIdentifiers"].remove(f"{base}.backfill")
    elif mutation == "foreign":
        info["BGTaskSchedulerPermittedIdentifiers"][-1] = "org.example.other.backfill"
    info["OmnesisKeychainAccessGroup"] = f"EXAMPLE.{base}.notifications"
    info["OmnesisGoogleClientID"] = "123-example.apps.googleusercontent.com"
    info["CFBundleURLTypes"] = [{"CFBundleURLSchemes": [
        "omnesis", "com.googleusercontent.apps.123-example"
    ]}]
    info["OmnesisCloudRelayURL"] = "https://relay.example.org"
    bundles = {
        "": info,
        "PlugIns/OmnesisNotificationService.appex": {
            "CFBundleIdentifier": f"{base}.notification-service",
            "OmnesisKeychainAccessGroup": info["OmnesisKeychainAccessGroup"],
            "NSLocalNetworkUsageDescription": "Connect to the paired gateway.",
        },
        "PlugIns/OmnesisWidgets.appex": {
            "CFBundleIdentifier": f"{base}.widgets",
            "NSLocalNetworkUsageDescription": "Connect to the paired gateway.",
        },
        "Watch/OmnesisWatch.app": {
            "CFBundleIdentifier": f"{base}.watchkitapp",
            "WKCompanionAppBundleIdentifier": base,
        },
        "Watch/OmnesisWatch.app/PlugIns/OmnesisWatchWidgets.appex": {
            "CFBundleIdentifier": f"{base}.watchkitapp.widgets",
        },
    }
    for suffix, metadata in bundles.items():
        bundle = app / suffix
        bundle.mkdir(parents=True, exist_ok=True)
        with (bundle / "Info.plist").open("wb") as stream:
            plistlib.dump(metadata, stream)
    result = subprocess.run([
        sys.executable, str(root / "ios/scripts/verify-built-identities.py"),
        str(products), base,
    ])
    sys.exit(result.returncode)
`;

describe("processed iOS background task identities", () => {
  it.each(["dev.omnesis.ios", "com.example.myomnesis"])(
    "accepts every declared background task and rejects missing or foreign IDs for %s",
    (base) => {
      for (const mutation of ["valid", "missing", "foreign"]) {
        const result = spawnSync(
          process.platform === "win32" ? "python" : "python3",
          ["-c", fixture, root, base, mutation],
          { encoding: "utf8", timeout: 10_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(mutation === "valid" ? 0 : 1);
        if (mutation !== "valid") expect(result.stderr).toContain("app background task IDs");
      }
    },
  );
});
