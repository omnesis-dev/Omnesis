// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import {
  compareNativeReconnect,
  comparePersistence,
  projectSnapshot,
} from "./docker-tailnet-probe.mjs";

// Exercise the actual shell handshake: a healthy collector's persisted
// ever-authenticated timestamp does not advance on a WebSocket reconnect.
function lifecycle(online) {
  const work = mkdtempSync(join(tmpdir(), "tailnet-reconnect-"));
  const pairing = {
    state: "paired",
    deviceName: "fixture-mac",
    gatewayUrl: "https://gateway.example.com",
    tokenFingerprint: "a".repeat(16),
    lastAuthenticatedAt: 1,
  };
  const service = (pid) => ({ items: [{ component: "collector", state: "running", pid }] });
  const json = (name, value) => writeFileSync(join(work, name), JSON.stringify(value));
  json("pairing.json", pairing);
  json("pairing-after.json", { ...pairing, lastAuthenticatedAt: 2 });
  json("services-before.json", service(1));
  json("services-after.json", service(2));
  const cli = join(work, "omnesis");
  writeFileSync(
    cli,
    '#!/bin/sh\nif [ "$2" = restart ]; then cp "$E2E_WORK/pairing-after.json" "$PAIRING_STATE"; else cat "$E2E_WORK/services-after.json"; fi\n',
  );
  chmodSync(cli, 0o700);
  try {
    return spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
. "$SOURCE/scripts/install-e2e/lib.sh"
. "$SOURCE/scripts/install-e2e/docker-tailnet-collector.sh"
OMNESIS="$E2E_WORK/omnesis"
wait_for() { case "$1" in gateway-restarted|gateway-reconnected) [ "$ONLINE" = 1 ] && echo ok ;; *) return 0 ;; esac; }
mailbox() { return 0; }
redacted() { "$@"; }
sleep() { :; }
date() { count=$(cat "$E2E_WORK/clock" 2>/dev/null || echo 0); count=$((count+100)); echo "$count" > "$E2E_WORK/clock"; echo "$count"; }
docker_native_restart
`,
      ],
      {
        env: {
          ...process.env,
          HOME: work,
          E2E_WORK: work,
          SOURCE: resolve("."),
          PAIRING_STATE: join(work, "pairing.json"),
          ONLINE: online ? "1" : "0",
          MAILBOX: "http://127.0.0.1:1",
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
test("accepts gateway-verified reconnect with unchanged persisted authentication timestamp", () => {
  const result = lifecycle(true);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
test("a stale paired file cannot bypass an offline gateway's missing reconnect proof", () => {
  const result = lifecycle(false);
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("never verified the native reconnection");
});

test("fresh gateway roster must contain the same authenticated native device", () => {
  const health = { status: "ok", version: "0.6.0" };
  const status = { documents: { total: 3 } };
  const device = {
    id: "fictional-device",
    name: "fixture-mac",
    kind: "collector",
    online: true,
    version: "0.6.0",
  };
  const documents = { results: [{ id: "fictional-document", title: "Harbor lantern checklist" }] };
  const expected = { version: "0.6.0", title: documents.results[0].title };
  const capture = (row) => projectSnapshot(health, status, { items: [row] }, documents, expected);
  const before = capture(device);
  expect(() => comparePersistence(before, capture({ ...device }))).not.toThrow();
  expect(() => capture({ ...device, online: false })).toThrow("native collector online");
  expect(() =>
    comparePersistence(before, capture({ ...device, id: "replacement-device" })),
  ).toThrow();
});

test("native identity and PID remain stable while an ever-authenticated timestamp may stay unchanged", () => {
  const services = { items: [{ component: "collector", state: "running", pid: 2 }] };
  const pairing = {
    state: "paired",
    deviceName: "fixture-mac",
    gatewayUrl: "https://gateway.example.com",
    tokenFingerprint: "a".repeat(16),
    lastAuthenticatedAt: 2,
  };
  expect(() =>
    compareNativeReconnect(services, structuredClone(services), pairing, structuredClone(pairing)),
  ).not.toThrow();
  for (const patch of [
    { state: "needs-pairing" },
    { deviceName: "replacement" },
    { gatewayUrl: "https://replacement.example.com" },
    { tokenFingerprint: "b".repeat(16) },
    { lastAuthenticatedAt: 1 },
  ])
    expect(() =>
      compareNativeReconnect(services, services, pairing, { ...pairing, ...patch }),
    ).toThrow();
  for (const patch of [{ pid: 3 }, { pid: null }, { state: "stopped" }])
    expect(() =>
      compareNativeReconnect(
        services,
        { items: [{ ...services.items[0], ...patch }] },
        pairing,
        pairing,
      ),
    ).toThrow();
});

test("the actual gateway capture loop times out rather than acknowledging an offline collector", () => {
  const source = readFileSync("scripts/install-e2e/docker-tailnet-gateway.sh", "utf8");
  const capture = source.match(/capture\(\) \{[\s\S]*?\n\}/u)?.[0];
  expect(capture).toBeTypeOf("string");
  const work = mkdtempSync(join(tmpdir(), "tailnet-offline-"));
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
node() { return 1; }
sleep() { :; }
die() { echo "$*"; exit 1; }
date() { count=$(cat "$E2E_WORK/clock" 2>/dev/null || echo 0); count=$((count+100)); echo "$count" > "$E2E_WORK/clock"; echo "$count"; }
${capture}
capture gateway-restarted
`,
      ],
      {
        env: {
          ...process.env,
          E2E_WORK: work,
          E2E_DIR: work,
          GATEWAY_URL: "https://gateway.example.com",
          TOKEN_FILE: join(work, "unused-token"),
          SEARCH_WORD: "fictional",
          SEARCH_TITLE: "Invented note",
          version: "0.6.0",
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("exact native corpus/device did not settle");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
