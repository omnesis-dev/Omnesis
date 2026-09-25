#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Helper: install an APNs Auth Key (.p8) for Omnesis, and patch
 * ~/.config/omnesis/omnesis.json to wire it into `gateway.apns`.
 *
 * APNs Auth Keys are NOT mintable via the App Store Connect API
 * (`POST /v1/apnsKeys` doesn't exist — Apple only manages these under
 * Apple Developer → Certificates, Identifiers & Profiles → Keys).
 * So this script asks the user to download the .p8 from the portal
 * once, then automates the on-disk install + config patch.
 *
 * Usage:
 *
 *   1. (Manual, one-off in the Apple Developer portal)
 *      a. Sign in at https://developer.apple.com/account
 *      b. Certificates, Identifiers & Profiles → Keys → "+"
 *      c. Name it e.g. "Omnesis APNs", check "Apple Push Notifications
 *         service (APNs)", click Continue → Register → Download.
 *      d. Note the 10-char Key ID printed on the page (you can't see
 *         it again after leaving).
 *
 *   2. (Automated by this script)
 *      node scripts/provision-apns-key.mjs <path-to-AuthKey_XXX.p8> <KEY_ID>
 *
 * The script copies the .p8 to ~/.config/omnesis/, patches the
 * gateway.apns block of omnesis.json, and prints a "restart the
 * gateway" reminder.
 */

import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const TEAM_ID = "68BFYTXMBS";
const BUNDLE_ID = "dev.omnesis.ios";
const OMNESIS_CONFIG_DIR = join(homedir(), ".config/omnesis");
const OMNESIS_JSON = join(OMNESIS_CONFIG_DIR, "omnesis.json");

function usage() {
  console.error("Usage: node scripts/provision-apns-key.mjs <path-to-.p8> <KEY_ID>");
  console.error("");
  console.error("Provision the .p8 manually first:");
  console.error("  1. https://developer.apple.com/account → Certificates, IDs & Profiles → Keys");
  console.error("  2. + → name 'Omnesis APNs' → check 'Apple Push Notifications service (APNs)'");
  console.error("  3. Continue → Register → Download the .p8");
  console.error("  4. Note the 10-char Key ID — you can't see it after leaving the page.");
  process.exit(1);
}

async function main() {
  const [srcArg, keyId] = process.argv.slice(2);
  if (!srcArg || !keyId) usage();
  if (!/^[A-Z0-9]{10}$/.test(keyId)) {
    console.error(
      `Key ID '${keyId}' doesn't look right — expected 10 uppercase alphanumeric chars.`,
    );
    process.exit(1);
  }
  const src = resolve(srcArg);
  if (!existsSync(src)) {
    console.error(`File not found: ${src}`);
    process.exit(1);
  }
  await mkdir(OMNESIS_CONFIG_DIR, { recursive: true });
  const dst = join(OMNESIS_CONFIG_DIR, `AuthKey_${keyId}.p8`);
  if (existsSync(dst)) {
    console.error(`Already exists: ${dst}. Move it aside if you really want to replace it.`);
    process.exit(1);
  }
  await copyFile(src, dst);
  console.error(`→ copied ${basename(src)} → ${dst}`);

  let config = {};
  if (existsSync(OMNESIS_JSON)) {
    try {
      config = JSON.parse(await readFile(OMNESIS_JSON, "utf8"));
    } catch (err) {
      console.error(`Could not parse existing ${OMNESIS_JSON}: ${err.message}`);
      console.error("Refusing to overwrite an unreadable config — fix it first, then re-run.");
      process.exit(1);
    }
  }
  config.gateway = config.gateway || {};
  config.gateway.apns = {
    keyPath: dst,
    keyId,
    teamId: TEAM_ID,
    bundleId: BUNDLE_ID,
    environment: "production",
  };
  await writeFile(OMNESIS_JSON, JSON.stringify(config, null, 2) + "\n");
  console.error(`→ patched ${OMNESIS_JSON}:`);
  console.error("");
  console.error(JSON.stringify({ apns: config.gateway.apns }, null, 2));
  console.error("");
  console.error("Restart the gateway to pick up the new APNs config.");
  console.error("If you use `production` builds via TestFlight, leave environment='production'.");
  console.error("For Xcode-debug installs (sandbox APNs tokens), flip environment='sandbox'.");
}

main().catch((err) => {
  console.error(`provision-apns-key: ${err.message}`);
  process.exit(1);
});
