// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const directory = process.env.OMNESIS_CONFIG_DIR;
if (!directory) throw new Error("The auth fixture requires an isolated state directory");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "code" && message.code === "finish") process.exit(0);
});

let port;
if (process.platform === "win32") {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "require('node:net').createServer(s => { s.on('error', () => {}); s.end(); }).listen(0, '127.0.0.1', function () { process.stdout.write(String(this.address().port) + '\\n'); });",
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  port = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (bytes) => {
      output += bytes.toString("utf8");
      if (output.includes("\n")) resolve(Number(output.trim()));
    });
    child.once("error", reject);
  });
  child.unref();
}
writeFileSync(join(directory, "cohort.json"), JSON.stringify({ port }), { mode: 0o600 });
process.stdout.write(
  JSON.stringify({ type: "url", url: "https://auth.example.test/fixture" }) + "\n",
);
process.stdout.end(JSON.stringify({ type: "complete", accountIds: ["one@example.com"] }) + "\n");
