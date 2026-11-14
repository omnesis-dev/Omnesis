// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { win32 } from "node:path";
import { execWindowsJob } from "@omnesis/core";

/** Tasklist CSV is five quoted fields; commas and doubled quotes stay inside a field. */
export function tasklistHasImage(csv: string, processName: string): boolean {
  if (csv.includes("\uFFFD")) throw new Error("Invalid Windows process list encoding");
  const wanted = (
    processName.toLowerCase().endsWith(".exe") ? processName : `${processName}.exe`
  ).toLowerCase();
  const records = csv.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (records.length === 0) throw new Error("Windows process list was empty");
  let found = false;
  for (const line of records) {
    const row = /^"((?:[^"]|"")*)","[0-9]+","(?:[^"]|"")*","[0-9]+","(?:[^"]|"")*"$/u.exec(line);
    if (!row) throw new Error("Invalid Windows process list CSV");
    const image = row[1]!.replaceAll('""', '"');
    if (image.toLowerCase() === wanted) found = true;
  }
  return found;
}

/** Read the system process table through an owned native job, never a PATH tool or shell filter. */
export async function windowsIsProcessRunning(
  name: string,
  timeoutMs: number,
  {
    env = process.env,
    run = execWindowsJob,
  }: { env?: NodeJS.ProcessEnv; run?: typeof execWindowsJob } = {},
): Promise<boolean> {
  const systemRoot = ["systemroot", "windir"]
    .map((key) => {
      const actual = Object.keys(env)
        .sort()
        .find((candidate) => candidate.toLowerCase() === key);
      return actual === undefined ? undefined : env[actual];
    })
    .find((value) => value !== undefined);
  if (!systemRoot || !win32.isAbsolute(systemRoot))
    throw new Error("Windows system directory is unavailable");
  const { stdout } = await run(
    win32.join(systemRoot, "System32", "tasklist.exe"),
    ["/FO", "CSV", "/NH"],
    {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env,
    },
  );
  return tasklistHasImage(stdout, name);
}
