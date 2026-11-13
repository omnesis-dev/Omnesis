// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { request } from "node:https";
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function localGateway(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.port === "7600" ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  )
    throw new Error("Native E2E pairing requires an isolated loopback HTTPS gateway.");
  return url;
}

function postJson(base, path, body, token) {
  return new Promise((resolveReply, reject) => {
    const encoded = JSON.stringify(body);
    // Only the isolated test gateway uses a fresh self-signed certificate.
    const pending = request(
      new URL(path, base),
      {
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(encoded),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300)
            return reject(new Error(`Native E2E pairing ${path}: HTTP ${response.statusCode}`));
          try {
            resolveReply(JSON.parse(text));
          } catch {
            reject(new Error("Native E2E pairing returned invalid JSON."));
          }
        });
      },
    );
    pending.on("error", reject);
    pending.setTimeout(20_000, () => pending.destroy(new Error("Native E2E pairing timed out.")));
    pending.end(encoded);
  });
}

/** Exercise real pairing: a bootstrap or a collector token is not an owner phone. */
export async function pairNativeOwner({ gatewayURL, bootstrapToken, kind, post = postJson }) {
  const base = localGateway(gatewayURL);
  if (kind !== "ios" && kind !== "android") throw new Error("Use a native phone device kind.");
  const pending = await post(
    base,
    "/admin/devices/pair",
    { kind, name: "Native scope test phone" },
    bootstrapToken,
  );
  if (typeof pending.pairingCode !== "string" || !pending.pairingCode)
    throw new Error("Native E2E pairing did not return a code.");
  const paired = await post(base, "/devices/pair", { pairingCode: pending.pairingCode });
  if (
    typeof paired.token !== "string" ||
    !paired.token ||
    paired.device?.kind !== kind ||
    typeof paired.device?.id !== "string" ||
    !paired.scopes?.includes("admin")
  )
    throw new Error("Native E2E pairing did not produce a registered owner phone.");
  return { gatewayURL: base.origin, apiToken: paired.token, deviceId: paired.device.id };
}

export function writeNativeConfig(path, config) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(config), { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [gatewayURL, tokenFile, kind, output, tlsFingerprint] = process.argv.slice(2);
  try {
    const config = await pairNativeOwner({
      gatewayURL,
      bootstrapToken: readFileSync(tokenFile, "utf8").trim(),
      kind,
    });
    writeNativeConfig(output, { ...config, ...(tlsFingerprint ? { tlsFingerprint } : {}) });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
