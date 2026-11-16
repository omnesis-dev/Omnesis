// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { createRequire } from "node:module";
import { execWindowsJob, ownedProcessCleanupReceipt } from "@omnesis/core";
const requireGateway = createRequire(
  new URL("../../packages/gateway/package.json", import.meta.url),
);
let sharpResolvable = false;
try {
  sharpResolvable = Boolean(requireGateway.resolve("sharp"));
} catch {}
let tesseractAvailable = false;
try {
  const result = await execWindowsJob("tesseract", ["--version"], {
    timeout: 5000,
    maxBuffer: 4096,
  });
  tesseractAvailable = /tesseract/i.test(result.stdout + result.stderr);
} catch (error) {
  if (ownedProcessCleanupReceipt(error) !== undefined) throw error;
}
process.stdout.write(
  JSON.stringify({ phase: "native-ocr-dependency-probe", sharpResolvable, tesseractAvailable }) +
    "\n",
);
