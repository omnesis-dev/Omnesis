#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Exact, model-free identity assertions for the Docker/native tailnet lane. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import tls from "node:tls";
import { createRedactor, readSecretsFile } from "./redact.mjs";
import { parseCommand } from "./args.mjs";

const nonempty = (value) => typeof value === "string" && value.length > 0;
export function projectSnapshot(health, status, roster, documents, { version, title }) {
  assert.equal(health?.status, "ok", "gateway health");
  assert.equal(health.version, version, "gateway version");
  assert.equal(status?.documents?.total, 3, "exact invented vault document count");
  assert(Array.isArray(roster?.items), "typed device roster");
  const collectors = roster.items.filter((row) => row.kind === "collector" && !row.revokedAt);
  assert.equal(collectors.length, 1, "exactly one native collector");
  const collector = collectors[0];
  assert(nonempty(collector.id) && nonempty(collector.name), "collector identity");
  assert.equal(collector.online, true, "native collector online");
  assert.equal(collector.version, version, "native collector version");
  assert(Array.isArray(documents?.results), "typed document lookup");
  assert.equal(documents.results.length, 1, "unique invented lookup result");
  assert.equal(documents.results[0].title, title, "invented title");
  assert(nonempty(documents.results[0].id), "persisted document ID");
  return {
    version,
    collectorId: collector.id,
    collectorName: collector.name,
    documentId: documents.results[0].id,
    title,
    documentTotal: status.documents.total,
  };
}

export function comparePersistence(before, after) {
  assert.deepEqual(after, before, "native device and stored document identities survive restart");
}

function nativeServicePid(body) {
  assert(Array.isArray(body?.items), "typed native service status");
  const rows = body.items.filter((row) => row.component === "collector");
  assert.equal(rows.length, 1, "one collector service");
  assert.equal(rows[0].state, "running", "collector service running");
  assert(Number.isInteger(rows[0].pid) && rows[0].pid > 0, "positive collector PID");
  return rows[0].pid;
}

function comparePairingIdentity(beforePairing, afterPairing) {
  for (const state of [beforePairing, afterPairing]) {
    assert.equal(state?.state, "paired", "native pairing state");
    assert(nonempty(state.deviceName) && nonempty(state.gatewayUrl), "native pairing identity");
    assert(
      typeof state.tokenFingerprint === "string" && /^[0-9a-f]{16}$/.test(state.tokenFingerprint),
      "logical credential fingerprint",
    );
    assert(
      Number.isFinite(state.lastAuthenticatedAt) && state.lastAuthenticatedAt > 0,
      "actual authentication",
    );
  }
  for (const key of ["deviceName", "gatewayUrl", "tokenFingerprint"])
    assert.equal(afterPairing[key], beforePairing[key], `native ${key} survives restart`);
}

export function compareNativeRestart(beforeServices, afterServices, beforePairing, afterPairing) {
  assert.notEqual(
    nativeServicePid(beforeServices),
    nativeServicePid(afterServices),
    "native service PID changes",
  );
  comparePairingIdentity(beforePairing, afterPairing);
  assert(
    afterPairing.lastAuthenticatedAt > beforePairing.lastAuthenticatedAt,
    "fresh authentication after native restart",
  );
}

/** The gateway independently proves its current authenticated socket first. */
export function compareNativeReconnect(beforeServices, afterServices, beforePairing, afterPairing) {
  assert.equal(
    nativeServicePid(beforeServices),
    nativeServicePid(afterServices),
    "native service PID survives gateway restart",
  );
  comparePairingIdentity(beforePairing, afterPairing);
  // This is an ever-authenticated credential record, not a WebSocket clock.
  assert(
    afterPairing.lastAuthenticatedAt >= beforePairing.lastAuthenticatedAt,
    "native authentication history retained",
  );
}

/** CA+hostname verification remains enabled, then require the additional pin. */
export function verifyPeer(url, fingerprint, { ca } = {}) {
  assert(/^sha256:[0-9a-f]{64}$/.test(fingerprint), "typed TLS pin");
  const target = new URL(url);
  assert.equal(target.protocol, "https:");
  return new Promise((done, fail) => {
    const socket = tls.connect({
      host: target.hostname,
      port: Number(target.port || 443),
      servername: target.hostname,
      ...(ca ? { ca } : {}),
      rejectUnauthorized: true,
    });
    socket.setTimeout(15_000, () => socket.destroy(new Error("TLS peer deadline")));
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      try {
        assert.equal(socket.authorized, true, "CA and hostname verified");
        const actual =
          "sha256:" + socket.getPeerCertificate().fingerprint256.replaceAll(":", "").toLowerCase();
        assert.equal(actual, fingerprint, "gateway certificate pin");
        socket.end();
        done();
      } catch (error) {
        socket.destroy();
        fail(error);
      }
    });
  });
}

export async function verifyRefusals(url) {
  const forbidden = await fetch(new URL("/admin/devices", url), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(forbidden.status, 401, "unauthenticated admin request refused");
  const invalid = await fetch(new URL("/devices/pair", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode: "0000000000" }),
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(invalid.status, 400, "invalid pairing code refused");
  assert.equal((await invalid.json()).error, "invalid or expired pairing code");
}

/** Run the product's actual pair command in two new configuration directories. */
export function productPairRefusals({ cli, root, url, fingerprint, code }) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const redact = createRedactor(readSecretsFile(process.env.INSTALL_E2E_SECRETS_FILE));
  for (const [label, attemptedCode, pin, reason] of [
    ["wrong-pin", code, "sha256:" + "0".repeat(64), /fingerprint mismatch/i],
    ["wrong-code", "0000000000", fingerprint, /invalid or expired pairing code/i],
  ]) {
    const config = mkdtempSync(join(root, label + "-"));
    const saved = join(config, "saved-token");
    const env = { ...process.env, OMNESIS_CONFIG_DIR: config, OMNESIS_SECRET_STORE: "file" };
    delete env.OMNESIS_TOKEN;
    delete env.OMNESIS_ADMIN_TOKEN;
    const child = spawnSync(
      cli,
      ["pair", attemptedCode, "--gateway-url", url, "--trust-fingerprint", pin, "--save", saved],
      { env, encoding: "utf8", timeout: 60000 },
    );
    const output = (child.stdout || "") + (child.stderr || "");
    writeFileSync(join(config, "refusal.log"), output, { mode: 0o600 });
    const valid =
      !child.error &&
      !child.signal &&
      Number.isInteger(child.status) &&
      child.status > 0 &&
      reason.test(output);
    if (!valid) console.error(redact(output).slice(-4096));
    assert(valid, `actual product CLI ${label} must refuse for its specific reason`);
    for (const file of [saved, join(config, "token"), join(config, "collector-token")])
      assert(!existsSync(file), "refused product pairing must not save a credential");
  }
}

/** Revocation succeeds only for an unused code: wrong-pin must not redeem it. */
export async function revokeUnusedCode(url, token, code) {
  const response = await fetch(new URL("/admin/devices/pair", url), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode: code }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, "unused pairing-code revocation");
  assert.equal((await response.json()).revoked, true, "wrong-pin did not consume the real code");
}

async function main() {
  const { command, flags } = parseCommand(process.argv.slice(2), {
    "product-negative": {
      values: ["cli", "root", "url", "fingerprint", "code-file"],
      required: ["cli", "root", "url", "fingerprint", "code-file"],
    },
    "revoke-unused": {
      values: ["url", "token-file", "code-file"],
      required: ["url", "token-file", "code-file"],
    },
    capture: {
      values: ["url", "token-file", "query", "title", "version", "out"],
      required: ["url", "token-file", "query", "title", "version", "out"],
    },
    compare: { values: ["before", "after"], required: ["before", "after"] },
    native: {
      values: ["before-services", "after-services", "before-pairing", "after-pairing"],
      required: ["before-services", "after-services", "before-pairing", "after-pairing"],
    },
    reconnect: {
      values: ["before-services", "after-services", "before-pairing", "after-pairing"],
      required: ["before-services", "after-services", "before-pairing", "after-pairing"],
    },
    negative: { values: ["url"], required: ["url"] },
    "reject-pin": { values: ["url", "fingerprint"], required: ["url", "fingerprint"] },
    peer: { values: ["url", "fingerprint"], required: ["url", "fingerprint"] },
  });
  const json = (name) => JSON.parse(readFileSync(flags[name], "utf8"));
  if (command === "product-negative")
    return productPairRefusals({
      cli: flags.cli,
      root: flags.root,
      url: flags.url,
      fingerprint: flags.fingerprint,
      code: readFileSync(flags["code-file"], "utf8").trim(),
    });
  if (command === "revoke-unused")
    return revokeUnusedCode(
      flags.url,
      readFileSync(flags["token-file"], "utf8").trim(),
      readFileSync(flags["code-file"], "utf8").trim(),
    );
  if (command === "negative") return verifyRefusals(flags.url);
  if (command === "reject-pin") {
    try {
      await verifyPeer(flags.url, flags.fingerprint);
    } catch (error) {
      if (error.code === "ERR_ASSERTION" && error.message.includes("gateway certificate pin"))
        return;
      throw error;
    }
    throw new Error("wrong TLS pin was accepted");
  }
  if (command === "peer") return verifyPeer(flags.url, flags.fingerprint);
  if (command === "compare") return comparePersistence(json("before"), json("after"));
  if (command === "native" || command === "reconnect")
    return (command === "native" ? compareNativeRestart : compareNativeReconnect)(
      json("before-services"),
      json("after-services"),
      json("before-pairing"),
      json("after-pairing"),
    );
  const token = readFileSync(flags["token-file"], "utf8").trim();
  assert(nonempty(token), "private scoped probe token");
  const get = async (path) => {
    const response = await fetch(new URL(path, flags.url), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    assert(response.ok, `probe HTTP ${response.status}`);
    return response.json();
  };
  const data = await Promise.all([
    get("/health"),
    get("/status"),
    get("/admin/devices"),
    get(`/documents/search?q=${encodeURIComponent(flags.query)}&limit=10`),
  ]);
  writeFileSync(
    flags.out,
    JSON.stringify(projectSnapshot(...data, { version: flags.version, title: flags.title })) + "\n",
    { mode: 0o600 },
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const redact = createRedactor(readSecretsFile(process.env.INSTALL_E2E_SECRETS_FILE));
    console.error(
      redact(
        `Docker/native tailnet: ${error instanceof Error ? error.message : "assertion failed"}`,
      ),
    );
    process.exit(1);
  });
}
