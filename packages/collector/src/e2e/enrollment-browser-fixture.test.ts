// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { writeNoBrowserPreload } from "./enrollment-browser-fixture.js";

it("suppresses the actual platform browser command and records literal URL argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "enrollment-browser-"));
  const url = "https://relay.example.test/path?value=雪&literal=$()'quoted'";
  const command =
    process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const preload = await writeNoBrowserPreload(directory);
    const run = await promisify(execFile)(process.execPath, [
      "--require",
      preload,
      "--input-type=module",
      "-e",
      `
import {spawn} from 'node:child_process';
const child=spawn(${JSON.stringify(command)},${JSON.stringify(args)},{stdio:'ignore'});
child.once('error',()=>process.exitCode=99);
child.once('exit',(code)=>process.stdout.write(String(code)));
`,
    ]);
    expect(run.stdout).toBe("1");
    expect(await readFile(join(directory, "launches.txt"), "utf8")).toBe(url + "\n");
    const untouched = await promisify(execFile)(process.execPath, [
      "--require",
      preload,
      "-e",
      "process.stdout.write('untouched')",
    ]);
    expect(untouched.stdout).toBe("untouched");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
