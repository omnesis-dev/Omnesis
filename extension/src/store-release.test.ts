// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PAIRING_PROTOCOL_VERSION } from "@omnesis/core";
import JSZip from "jszip";
import sharp from "sharp";

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
);
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const contract = JSON.parse(
  readFileSync(new URL("../release-contract.json", import.meta.url), "utf8"),
);
const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("Chrome Web Store release contract", () => {
  it("packages against one caller-recorded commit without refreshing a shared ref", () => {
    const packageScript = readFileSync(join(extensionRoot, "scripts", "package-store.mjs"), "utf8");
    expect(packageScript).toContain("OMNESIS_EXTENSION_RELEASE_COMMIT");
    expect(packageScript).not.toContain('["fetch"');
    expect(packageScript).not.toContain("origin/main");
  });

  it("keeps the package, manifest, and review contract on one product version", () => {
    expect(manifest.version).toBe(packageJson.version);
    expect(contract.productVersion).toBe(packageJson.version);
    expect(contract.minimumChromeVersion).toBe(String(manifest.minimum_chrome_version));
    expect(contract.pairingProtocol).toBe(PAIRING_PROTOCOL_VERSION);
    expect(contract.sourceRepository).toBe("https://github.com/omnesis-dev/Omnesis");
  });

  it("declares exactly the gateway routes browser capture uses", () => {
    expect(contract.gatewayRoutes).toEqual([
      { method: "GET", path: "/health", authenticated: false },
      { method: "POST", path: "/devices/pair", authenticated: false },
      { method: "GET", path: "/web-capture-policy", authenticated: true },
      { method: "POST", path: "/web-capture-policy/excluded-domains", authenticated: true },
      {
        method: "DELETE",
        path: "/web-capture-policy/excluded-domains/:domain",
        authenticated: true,
      },
      { method: "PUT", path: "/web-capture-policy/pause", authenticated: true },
      { method: "DELETE", path: "/web-capture-policy/pause", authenticated: true },
      { method: "POST", path: "/documents", authenticated: true },
      { method: "POST", path: "/analytics/ingest", authenticated: true },
    ]);
    expect(contract.tokenScopes).toEqual(["write:web"]);
    expect(contract.deviceKind).toBe("browser");
  });

  it("uses Manifest V3 with optional HTTPS access and no remotely hosted code surface", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("130");
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
    expect(manifest.permissions).toEqual(["storage", "unlimitedStorage", "alarms", "scripting"]);
    expect(manifest.incognito).toBe("not_allowed");
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(manifest).not.toHaveProperty("content_security_policy");
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(manifest).not.toHaveProperty("web_accessible_resources");
  });

  it("produces the same allowlisted archive across timezone and umask differences", async () => {
    const packageScript = join(extensionRoot, "scripts", "package-store.mjs");
    // Package into a scratch directory: the developer's loaded `dist/` and the
    // release `artifacts/` directory must not change because tests ran.
    const scratch = mkdtempSync(join(tmpdir(), "omnesis-extension-store-"));
    const artifact = join(scratch, "artifacts", `omnesis-browser-capture-${manifest.version}.zip`);
    const build = (timezone: string, umask: string) => {
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `process.umask(${umask}); await import(${JSON.stringify(pathToFileURL(packageScript).href)});`,
        ],
        {
          cwd: extensionRoot,
          env: {
            ...process.env,
            TZ: timezone,
            OMNESIS_EXTENSION_DIST_DIR: join(scratch, "dist"),
            OMNESIS_EXTENSION_ARTIFACTS_DIR: join(scratch, "artifacts"),
          },
          stdio: "pipe",
        },
      );
      return readFileSync(artifact);
    };
    try {
      const first = build("UTC", "0o022");
      const second = build("Pacific/Honolulu", "0o077");
      expect(second).toEqual(first);

      const archive = await JSZip.loadAsync(second);
      expect(Object.keys(archive.files).sort()).toEqual([
        "LICENSE",
        "SOURCE.txt",
        "THIRD_PARTY_NOTICES.txt",
        "background.js",
        "content.js",
        "icons/icon-128.png",
        "icons/icon-16.png",
        "icons/icon-32.png",
        "icons/icon-48.png",
        "manifest.json",
        "options.html",
        "options.js",
        "popup.html",
        "popup.js",
        "ui.css",
      ]);
      expect(Object.keys(archive.files).some((path) => path.endsWith(".map"))).toBe(false);
      // The headless E2E's test manifest pre-grants host access and pins the
      // extension id; neither may ever reach the store.
      const packagedManifest = JSON.parse(
        (await archive.file("manifest.json")?.async("string")) ?? "{}",
      ) as Record<string, unknown>;
      expect(packagedManifest).not.toHaveProperty("key");
      expect(packagedManifest).not.toHaveProperty("host_permissions");
      expect(packagedManifest.optional_host_permissions).toEqual(["https://*/*"]);
      expect(await archive.file("THIRD_PARTY_NOTICES.txt")?.async("string")).toContain(
        "Copyright (c) 2025 Steph Ango",
      );
      expect(await archive.file("LICENSE")?.async("string")).toContain(
        "GNU AFFERO GENERAL PUBLIC LICENSE",
      );
      const source = await archive.file("SOURCE.txt")?.async("string");
      expect(source).toContain(
        `Source commit: ${execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: dirname(extensionRoot),
          encoding: "utf8",
        }).trim()}`,
      );
      // SOURCE.txt is the corresponding-source notice. While the repository is
      // private it must not ship a link that resolves to nothing; once it is
      // public the notice carries direct tree and build-instruction links, and
      // the build-instructions fragment must land on a real heading.
      if (contract.sourceAvailability === "on-request") {
        expect(source).not.toContain("/tree/");
        expect(source).not.toContain("/blob/");
        expect(source).toMatch(/on request from \S+@\S+/u);
      } else {
        expect(source).toContain(`${contract.sourceRepository}/tree/`);
        const anchor = /\/docs\/releasing\.md#([a-z0-9-]+)\n/u.exec(source ?? "")?.[1];
        const releasing = readFileSync(
          join(dirname(extensionRoot), "docs", "releasing.md"),
          "utf8",
        );
        const headingAnchors = [...releasing.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)].map((m) =>
          m[1]
            .toLowerCase()
            .replace(/[^\w\s-]/gu, "")
            .trim()
            .replace(/\s+/gu, "-"),
        );
        expect(anchor, "SOURCE.txt build-instructions fragment").toBeTruthy();
        expect(headingAnchors).toContain(anchor);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps the committed store screenshot in step with the options page it renders", async () => {
    const { STORE_ASSET_INPUTS_FILE, storeAssetInputsDigest } = (await import(
      pathToFileURL(join(extensionRoot, "scripts", "store-package-contract.mjs")).href
    )) as {
      STORE_ASSET_INPUTS_FILE: string;
      storeAssetInputsDigest: (root: string) => Promise<string>;
    };
    const recorded = readFileSync(
      join(extensionRoot, "store", "assets", STORE_ASSET_INPUTS_FILE),
      "utf8",
    ).trim();
    expect(
      recorded,
      "options.html, ui.css or the icon changed after the store screenshot was last rendered; run `npm --prefix extension run generate:store-assets`",
    ).toBe(await storeAssetInputsDigest(extensionRoot));
  });

  it("keeps committed store artwork at the required dimensions with padded icon artwork", async () => {
    const assets = join(extensionRoot, "store", "assets");
    await expect(
      sharp(join(assets, "pairing-and-controls-1280x800.png")).metadata(),
    ).resolves.toMatchObject({ width: 1280, height: 800 });
    await expect(
      sharp(join(assets, "small-promo-tile-440x280.png")).metadata(),
    ).resolves.toMatchObject({ width: 440, height: 280 });
    // The store rejects a marquee tile carrying an alpha channel, so the
    // generator flattens it; a screenshot saved straight to PNG would not be.
    await expect(
      sharp(join(assets, "marquee-promo-tile-1400x560.png")).metadata(),
    ).resolves.toMatchObject({ width: 1400, height: 560, channels: 3, hasAlpha: false });

    const iconPath = join(extensionRoot, "public", "icons", "icon-128.png");
    const { data, info } = await sharp(iconPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if (data[(y * info.width + x) * info.channels + 3] === 0) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    expect({ minX, minY, maxX, maxY }).toEqual({ minX: 16, minY: 16, maxX: 111, maxY: 111 });
  });
});
