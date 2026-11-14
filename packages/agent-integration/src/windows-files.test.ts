// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("source private filesystem helpers load under Node without compiled siblings", () => {
  const entry = new URL("./windows-files.ts", import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { privateWindowsFiles } = await import(${JSON.stringify(entry)});
const first = privateWindowsFiles();
if (typeof first.readWindowsPrivateFileContentsSync !== 'function' ||
    typeof first.writeWindowsPrivateFileAtomicSync !== 'function' ||
    first !== privateWindowsFiles()) throw new Error('Invalid source private filesystem runtime');
console.log('source helpers ready');`,
    ],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 15_000 },
  );
  expect(output.trim()).toBe("source helpers ready");
});
