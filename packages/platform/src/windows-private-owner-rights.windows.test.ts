// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { WINDOWS_PRIVATE_FILE_NATIVE_SOURCE } from "./native/windows-private-file-source.js";
import { runWindowsJob } from "./windows-job.js";
import { windowsPowerShellExecutable } from "./windows-powershell.js";

// Exercise the production predicate against descriptors without applying any
// fixture ACL or changing the Native helper's process or filesystem policies.
const fixture = String.raw`
public static partial class OmnesisPrivateFile {
  public static string FixtureOwnerRights() {
    string[] descriptors={
      "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)",
      "O:SYG:SYD:P(A;;FA;;;OW)",
      "O:S-1-5-21-100-200-300-1001G:BAD:P(A;;FA;;;OW)",
      "O:BAG:BAD:P(A;;FA;;;OW)(A;;FR;;;WD)"
    };
    List<string> rows=new List<string>();
    foreach(string sddl in descriptors) {
      RawSecurityDescriptor descriptor=new RawSecurityDescriptor(sddl);
      string before=descriptor.GetSddlForm(AccessControlSections.All);
      bool file=Private(descriptor,false),parent=Private(descriptor,true);
      bool unchanged=before==descriptor.GetSddlForm(AccessControlSections.All);
      rows.Add("{\"file\":"+file.ToString().ToLowerInvariant()+",\"parent\":"+parent.ToString().ToLowerInvariant()+",\"unchanged\":"+unchanged.ToString().ToLowerInvariant()+"}");
    }
    return "{\"ownerRightsIsTrustedOwner\":"+Trusted("S-1-3-4").ToString().ToLowerInvariant()+",\"rows\":["+String.Join(",",rows)+"]}";
  }
}`;

test.runIf(process.platform === "win32")(
  "owner-relative grants require a trusted actual owner and never authorize another principal",
  async () => {
    const result = await runWindowsJob(
      windowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop';Add-Type -TypeDefinition ([Console]::In.ReadToEnd());[Console]::Out.Write([OmnesisPrivateFile]::FixtureOwnerRights());",
      ],
      { input: Buffer.from(WINDOWS_PRIVATE_FILE_NATIVE_SOURCE + fixture), timeoutMs: 60_000 },
    );
    expect(Object.hasOwn(result, "cleanupFailure")).toBe(false);
    expect(result.failure, result.stderr).toBeUndefined();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      ownerRightsIsTrustedOwner: false,
      rows: [
        { file: true, parent: true, unchanged: true },
        { file: true, parent: true, unchanged: true },
        { file: false, parent: false, unchanged: true },
        { file: false, parent: false, unchanged: true },
      ],
    });
  },
  90_000,
);
