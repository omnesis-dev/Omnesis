#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Re-mint the "Omnesis App Store" provisioning profile so it picks
 * up the PUSH_NOTIFICATIONS capability we just enabled on the bundle
 * id. App Store Connect's profile API doesn't have an "update" verb
 * for the capability set — you delete + recreate.
 *
 * Side effects:
 *   - Deletes the old profile by id ($ASC_PROFILE_ID).
 *   - Creates a new profile with the same name, same cert relationship.
 *   - Decodes the new profileContent base64 → writes
 *     ~/Library/MobileDevice/Provisioning Profiles/<uuid>.mobileprovision
 *   - Prints the new UUID + id so you can record them for next time.
 *
 * Configure via env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_BUNDLE_ID_RECORD,
 * ASC_DIST_CERT_ID, ASC_PROFILE_ID (and optional ASC_KEY_PATH / ASC_PROFILE_NAME).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createSign } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function requireEnv(name, hint) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}${hint ? ` — ${hint}` : ""}.`);
    process.exit(1);
  }
  return value;
}

const APP_STORE_CONNECT_KEY_ID = requireEnv("ASC_KEY_ID", "App Store Connect API key id");
const APP_STORE_CONNECT_ISSUER = requireEnv("ASC_ISSUER_ID", "App Store Connect API issuer id");
const APP_STORE_CONNECT_KEY_PATH =
  process.env.ASC_KEY_PATH ??
  join(homedir(), ".appstoreconnect/private_keys", `AuthKey_${APP_STORE_CONNECT_KEY_ID}.p8`);

const BUNDLE_ID_RECORD = requireEnv("ASC_BUNDLE_ID_RECORD", "bundle id record for dev.omnesis.ios");
const DIST_CERT_ID = requireEnv("ASC_DIST_CERT_ID", "distribution certificate id");
const OLD_PROFILE_ID = requireEnv("ASC_PROFILE_ID", "existing provisioning profile id to replace");
const PROFILE_NAME = process.env.ASC_PROFILE_NAME ?? "Omnesis App Store";

function base64url(s) {
  return Buffer.from(s)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function base64urlBuf(b) {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function jwt() {
  const keyPem = await readFile(APP_STORE_CONNECT_KEY_PATH, "utf8");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(
    JSON.stringify({ alg: "ES256", kid: APP_STORE_CONNECT_KEY_ID, typ: "JWT" }),
  );
  const claims = base64url(
    JSON.stringify({
      iss: APP_STORE_CONNECT_ISSUER,
      iat: now,
      exp: now + 19 * 60,
      aud: "appstoreconnect-v1",
    }),
  );
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${base64urlBuf(signer.sign({ key: keyPem, dsaEncoding: "ieee-p1363" }))}`;
}

async function asc(method, path, body) {
  const token = await jwt();
  const resp = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 204) return null;
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${method} ${path}: ${resp.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  console.error(`→ deleting old profile ${OLD_PROFILE_ID}…`);
  try {
    await asc("DELETE", `/v1/profiles/${OLD_PROFILE_ID}`);
    console.error("  deleted.");
  } catch (err) {
    if (/404/.test(err.message)) {
      console.error("  (already gone)");
    } else {
      throw err;
    }
  }

  console.error(`→ creating new profile "${PROFILE_NAME}" (IOS_APP_STORE)…`);
  const created = await asc("POST", "/v1/profiles", {
    data: {
      type: "profiles",
      attributes: { name: PROFILE_NAME, profileType: "IOS_APP_STORE" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: BUNDLE_ID_RECORD } },
        certificates: { data: [{ type: "certificates", id: DIST_CERT_ID }] },
      },
    },
  });

  const newId = created.data.id;
  const uuid = created.data.attributes.uuid;
  const profileContentB64 = created.data.attributes.profileContent;
  console.error(`  new id=${newId}  uuid=${uuid}`);

  const buf = Buffer.from(profileContentB64, "base64");
  const dst = join(
    homedir(),
    "Library/MobileDevice/Provisioning Profiles",
    `${uuid}.mobileprovision`,
  );
  await mkdir(join(homedir(), "Library/MobileDevice/Provisioning Profiles"), { recursive: true });
  if (existsSync(dst)) {
    console.error(`  (file already exists at ${dst} — overwriting)`);
  }
  await writeFile(dst, buf);
  console.error(`  wrote ${dst}`);

  console.error("");
  console.error("✓ done. Update CLAUDE.local.md with:");
  console.error(`  - Provisioning profile ID: ${newId}`);
  console.error(`  - Provisioning profile UUID: ${uuid}`);
}

main().catch((err) => {
  console.error(`remint-app-store-profile: ${err.message}`);
  process.exit(1);
});
