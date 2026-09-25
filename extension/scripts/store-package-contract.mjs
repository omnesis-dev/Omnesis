// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Sidecar in `store/assets/` naming the inputs the committed screenshot was rendered from. */
export const STORE_ASSET_INPUTS_FILE = "inputs.sha256";

/**
 * SHA-256 over the files `generate-store-assets.mjs` renders: the options page,
 * the stylesheet and the icon. A change to any of them without a regenerated
 * screenshot leaves the committed artwork showing a page that no longer exists.
 */
export async function storeAssetInputsDigest(root) {
  const hash = createHash("sha256");
  for (const file of ["public/options.html", "public/ui.css", "public/icons/icon-128.png"]) {
    hash.update(file);
    hash.update(await readFile(join(root, file)));
  }
  return hash.digest("hex");
}

/**
 * GitHub heading anchor of the build-instructions section in docs/releasing.md.
 * SOURCE.txt in every store ZIP links to it as the AGPL corresponding-source
 * build recipe; `store-release.test.ts` checks the heading still exists.
 */
export const BUILD_INSTRUCTIONS_ANCHOR = "chrome-web-store-artifact";

export function assertReleaseVersions(manifest, packageJson, contract) {
  if (manifest.version !== packageJson.version || contract.productVersion !== packageJson.version) {
    throw new Error("Extension package, manifest, and release-contract versions must match.");
  }
  if (manifest.manifest_version !== 3) {
    throw new Error("Chrome Web Store builds must use Manifest V3.");
  }
}

export function assertReleaseCheckout({ dirty, head, expectedCommit }) {
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit ?? "")) {
    throw new Error("OMNESIS_EXTENSION_RELEASE_COMMIT must be an exact lowercase Git SHA.");
  }
  if (dirty !== "" || head !== expectedCommit) {
    throw new Error("Release packaging requires a clean checkout at the recorded release commit.");
  }
}

export function assertStoreFiles(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected store package contents: ${actual.join(", ")}`);
  }
}

export function assertArtifactReplacement({ releaseMode, existing, bytes, artifact }) {
  if (releaseMode && existing && !existing.equals(bytes)) {
    throw new Error(`Refusing to overwrite a different same-version release artifact: ${artifact}`);
  }
}
