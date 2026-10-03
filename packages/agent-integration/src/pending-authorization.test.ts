// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import {
  clearPendingAuthorization,
  loadPendingAuthorization,
  pendingAuthorizationPath,
  savePendingAuthorization,
  type PendingIntegrationAuthorization,
} from "./pending-authorization.js";

const HERMES_ADAPTER = fileURLToPath(new URL("../hermes/adapter.py", import.meta.url));
const directories: string[] = [];

function credentialsPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "omnesis-pending-authorization-"));
  directories.push(directory);
  return join(directory, "integration.json");
}

const PENDING: PendingIntegrationAuthorization = {
  gatewayUrl: "https://gateway.example.org:7600",
  clientId: "client_fictional",
  handle: "omn_oar_fictional",
  consentUrl: "https://gateway.example.org:7600/oauth/consent?request=omn_oar_fictional",
  expiresAt: 1_900_000_000_000,
  codeVerifier: "v".repeat(64),
  state: "s".repeat(40),
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the recorded approval request", () => {
  test("round-trips, privately, and clears", () => {
    const path = credentialsPath();
    expect(loadPendingAuthorization(path)).toBeNull();
    savePendingAuthorization(path, PENDING);
    expect(loadPendingAuthorization(path)).toEqual(PENDING);
    if (process.platform !== "win32") {
      expect(statSync(pendingAuthorizationPath(path)).mode & 0o777).toBe(0o600);
    }
    clearPendingAuthorization(path);
    expect(loadPendingAuthorization(path)).toBeNull();
    // Clearing what is not there is not an error.
    clearPendingAuthorization(path);
  });

  test("reads a malformed record as no record", () => {
    const path = credentialsPath();
    writeFileSync(pendingAuthorizationPath(path), "{not json");
    expect(loadPendingAuthorization(path)).toBeNull();
    writeFileSync(pendingAuthorizationPath(path), JSON.stringify({ handle: "only" }));
    expect(loadPendingAuthorization(path)).toBeNull();
  });

  test("is found where the Hermes adapter looks for it", () => {
    const source = readFileSync(HERMES_ADAPTER, "utf8");
    const suffix = pendingAuthorizationPath("");
    expect(source).toContain(`Path(f"{credential_path}${suffix}")`);
    expect(source).toContain(`recorded.get("expiresAt")`);
  });
});
