// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { WINDOWS_JOB_NATIVE_SOURCE, WINDOWS_JOB_POWERSHELL_SCRIPT } from "./windows-job-source.js";

describe("uncached Windows job bootstrap", () => {
  it("embeds the complete public native source in a lossless compressed bootstrap", () => {
    const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(
      WINDOWS_JOB_POWERSHELL_SCRIPT,
    )?.[1];
    expect(encoded).toBeDefined();
    expect(gunzipSync(Buffer.from(encoded!, "base64")).toString("utf8")).toBe(
      WINDOWS_JOB_NATIVE_SOURCE,
    );
    expect(WINDOWS_JOB_POWERSHELL_SCRIPT).toContain("[IO.Compression.CompressionMode]::Decompress");
  });

  it("fits the Windows CreateProcess command line including executable, switches and NUL", () => {
    const executable = '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"';
    const encoded = Buffer.from(WINDOWS_JOB_POWERSHELL_SCRIPT, "utf16le").toString("base64");
    const commandLine = `${executable} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}\0`;
    expect(commandLine.length).toBeLessThanOrEqual(32767);
  });
});
