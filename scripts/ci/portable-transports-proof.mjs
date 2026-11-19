// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { ensureTailnetTools } from "../tailnet-test/tools.mjs";
import { runCheckCommand } from "../lib/check-process.mjs";
const tools = await ensureTailnetTools();
if (!tools.portable) throw new Error("The actual portable tools were not selected");
process.exitCode = await runCheckCommand(
  "go",
  [
    "test",
    "-mod=readonly",
    "-p",
    "2",
    "-failfast",
    "-count=1",
    "-timeout",
    "6m",
    "-run",
    "^(TestActorProtocolCreatesRealPeersAndJoins|TestOfficialCLIThroughPrivateLocalAPI|TestPortableControlAndWireGuard|TestMapFingerprintPreservesTopologyChangesWithoutClockTraffic|TestStreamPresenceDrivesActualStatus)$",
    "-v",
    "./...",
  ],
  {
    cwd: "scripts/tailnet-test/control",
    env: {
      ...process.env,
      GOMAXPROCS: "2",
      CGO_ENABLED: "0",
      GOWORK: "off",
      PORTABLE_TAILSCALE_CLI_DIR: tools.portable.cliDirectory,
    },
  },
);
