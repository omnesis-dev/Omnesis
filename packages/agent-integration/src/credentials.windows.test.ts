// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { windowsPowerShellExecutable } from "@omnesis/platform/windows-powershell";
import {
  loadIntegrationCredentials,
  updateIntegrationOAuthState,
  writeIntegrationCredentials,
} from "./credentials.js";
import { privateWindowsFiles } from "./windows-files.js";

test.runIf(process.platform === "win32")(
  "integration refresh retains private native credentials and refuses unsafe existing ACLs",
  () => {
    const root = mkdtempSync(join(tmpdir(), "integration-private-credentials-"));
    const path = join(root, "credentials-[$&].json");
    const credentials = {
      gatewayUrl: "https://gateway.example.org:17601",
      deliveryToken: "invented-delivery-token",
      ingestionToken: "invented-ingestion-token",
      managementToken: "invented-management-token",
      oauth: {
        redirectUri: "http://127.0.0.1:17602/callback",
        clientInformation: {},
        tokens: { access_token: "invented-original-token" },
      },
    };
    try {
      writeIntegrationCredentials(path, credentials);
      updateIntegrationOAuthState(path, {
        ...credentials.oauth,
        tokens: { access_token: "invented-refreshed-token" },
      });
      expect(loadIntegrationCredentials(path).oauth.tokens.access_token).toBe(
        "invented-refreshed-token",
      );
      expect(readdirSync(root)).toEqual(["credentials-[$&].json"]);
      const original = readFileSync(path, "utf8");
      execFileSync(
        windowsPowerShellExecutable(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference='Stop';$path=$env:OMNESIS_INTEGRATION_ACL_TEST;
$acl=[System.IO.File]::GetAccessControl($path);
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]'S-1-1-0',[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow));
[System.IO.File]::SetAccessControl($path,$acl);`,
        ],
        { env: { ...process.env, OMNESIS_INTEGRATION_ACL_TEST: path }, timeout: 20_000 },
      );
      expect(() => loadIntegrationCredentials(path)).toThrow(
        /could not read integration credentials/,
      );
      expect(() => updateIntegrationOAuthState(path, credentials.oauth)).toThrow(
        /could not read integration credentials/,
      );
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(() => privateWindowsFiles().readWindowsPrivateFileContentsSync(path)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
