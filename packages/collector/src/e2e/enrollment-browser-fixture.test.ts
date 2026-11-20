// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { expect, it } from "vitest";
import { execE2EBufferedCommand } from "./e2e-buffered-command.js";
import { writeNoBrowserPreload } from "./enrollment-browser-fixture.js";

for (const synchronous of [false, true]) {
  for (const encoded of process.platform === "win32" ? [false, true] : [false]) {
    it(`suppresses actual browser argv and preserves child exit (sync=${synchronous}, encoded=${encoded})`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "enrollment-browser-"));
      const url = "https://relay.example.test/path?value=雪&literal=$()'quoted'&percent=%PATH%";
      const command = encoded
        ? "powershell.exe"
        : process.platform === "win32"
          ? "rundll32"
          : process.platform === "darwin"
            ? "open"
            : "xdg-open";
      const args = encoded
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(
              `Start-Process -FilePath '${url.replaceAll("'", "''")}'`,
              "utf16le",
            ).toString("base64"),
          ]
        : process.platform === "win32"
          ? ["url.dll,FileProtocolHandler", url]
          : [url];
      const options = {
        cwd: join(import.meta.dirname, "../../../.."),
        env: process.env,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      };
      let retainInputs = false;
      try {
        const preload = await writeNoBrowserPreload(directory);
        const run = await execE2EBufferedCommand(
          process.execPath,
          [
            "--require",
            preload,
            "--input-type=module",
            "-e",
            `
import {spawn,spawnSync} from 'node:child_process';
if (${synchronous}) {
  const child=spawnSync(${JSON.stringify(command)},${JSON.stringify(args)},{stdio:'ignore'});
  process.stdout.write(String(child.status));
} else {
  const child=spawn(${JSON.stringify(command)},${JSON.stringify(args)},{stdio:'ignore'});
  child.once('error',()=>process.exitCode=99);
  child.once('exit',(code)=>process.stdout.write(String(code)));
}
`,
          ],
          options,
        );
        expect(run.stdout).toBe("1");
        expect(await readFile(join(directory, "launches.txt"), "utf8")).toBe(url + "\n");
        const untouched = await execE2EBufferedCommand(
          process.execPath,
          ["--require", preload, "-e", "process.stdout.write('untouched')"],
          options,
        );
        expect(untouched.stdout).toBe("untouched");
      } catch (error) {
        retainInputs = ownedProcessCleanupReceipt(error) !== undefined;
        throw error;
      } finally {
        if (!retainInputs) await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
