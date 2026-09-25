#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Poll App Store Connect for the latest Omnesis build, wait until it
 * flips from PROCESSING → VALID, then PATCH `usesNonExemptEncryption`
 * to false so the build becomes visible to TestFlight testers.
 *
 * When the build's internal test group has hasAccessToAllBuilds=true it
 * joins automatically, so once the export-compliance PATCH succeeds the
 * build appears in the TestFlight app with an Install button.
 *
 * Configure via env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_APP_ID (and optional
 * ASC_KEY_PATH; defaults to ~/.appstoreconnect/private_keys/AuthKey_<id>.p8).
 */

import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";
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
const APP_ID = requireEnv("ASC_APP_ID", "App Store Connect app id");

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

async function listBuilds() {
  const out = await asc("GET", `/v1/builds?filter[app]=${APP_ID}&sort=-uploadedDate&limit=5`);
  return out.data ?? [];
}

async function patchExportCompliance(buildId) {
  return asc("PATCH", `/v1/builds/${buildId}`, {
    data: {
      type: "builds",
      id: buildId,
      attributes: { usesNonExemptEncryption: false },
    },
  });
}

async function main() {
  console.error("→ polling App Store Connect for latest build…");
  const targetVersion = process.argv[2] ?? null;
  const maxWaitMs = 30 * 60_000;
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < maxWaitMs) {
    const builds = await listBuilds();
    if (builds.length === 0) {
      console.error("  no builds yet — waiting…");
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    let pick;
    if (targetVersion) {
      pick = builds.find((b) => b.attributes?.version === targetVersion);
      if (!pick) {
        console.error(
          `  waiting for v${targetVersion} to show up (current latest: v${builds[0].attributes?.version})…`,
        );
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
    } else {
      pick = builds[0];
    }
    const state = pick.attributes?.processingState;
    const ver = pick.attributes?.version;
    if (state !== lastState) {
      console.error(`  build ${pick.id} v${ver}: ${state}`);
      lastState = state;
    }
    if (state === "VALID") {
      console.error("→ patching export-compliance (usesNonExemptEncryption: false)…");
      await patchExportCompliance(pick.id);
      console.error("✓ done. Tell the user to refresh TestFlight on the iPhone.");
      return;
    }
    if (state === "INVALID") {
      throw new Error(`Build ${pick.id} v${ver} is INVALID — see App Store Connect for details.`);
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  throw new Error("Timed out after 30 min waiting for processingState=VALID.");
}

main().catch((err) => {
  console.error(`patch-export-compliance: ${err.message}`);
  process.exit(1);
});
