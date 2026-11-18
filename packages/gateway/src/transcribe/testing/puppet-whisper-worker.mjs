// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Real-process protocol fixture. The parent supplies only invented model input.
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const emit = (header) => {
  const body = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([length, body]));
};
if (config.mode === "invalid") emit(null);
else if (config.mode === "normal") emit({ type: "ready" });
else if (config.descendant) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const net = require('node:net');
    const server = net.createServer(socket => socket.end('invented fixture listener'));
    server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({port:server.address().port})+'\\n'));
  `,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  let report = "";
  child.stdout.on("data", (chunk) => {
    report += chunk.toString();
    if (report.includes("\n")) {
      writeFileSync(
        config.record,
        JSON.stringify({
          pid: process.pid,
          descendantPid: child.pid,
          port: JSON.parse(report.split("\n")[0]).port,
        }),
      );
    }
  });
  child.on("error", () => process.exit(2));
} else writeFileSync(config.record, JSON.stringify({ pid: process.pid }));
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const size = input.readUInt32BE(0);
    if (input.length < 4 + size) return;
    const request = JSON.parse(input.subarray(4, 4 + size).toString("utf8"));
    const end = 4 + size + request.pcmBytes;
    if (input.length < end) return;
    input = input.subarray(end);
    emit({
      type: "result",
      id: request.id,
      text: "Invented physical worker transcript.",
      language: "en",
    });
  }
});
process.stdin.on("end", () => process.exit(0));
