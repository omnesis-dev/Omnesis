// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runCheckCommand } from "../lib/check-process.mjs";
const files = [
  "internal/certs/fallback.go",
  "internal/certs/fallback_test.go",
  "internal/protocol/protocol.go",
  "internal/protocol/protocol_test.go",
  "main.go",
  "main_test.go",
  "internal/node/node.go",
  "internal/proxy/proxy.go",
  "internal/proxy/endpoint.go",
  "internal/proxy/endpoint_test.go",
  "internal/proxy/dial_other.go",
  "internal/proxy/dial_windows.go",
  "test/proxy-fixture/main.go",
];
const base = "packages/tailnet-helper/";
const original = new Map(
  files.map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(base + file))
      .digest("hex"),
  ]),
);
const code = await runCheckCommand("gofmt", ["-w", ...files], { cwd: base });
if (code !== 0) process.exit(code);
for (const file of files)
  process.stdout.write(
    "AUDIT_FORMATTED_GO=" +
      JSON.stringify({
        file: base + file,
        original: original.get(file),
        formatted: readFileSync(base + file).toString("base64"),
      }) +
      "\n",
  );
