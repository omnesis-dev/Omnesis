// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The native Windows Job owns this host before node-pty can create the real
// ConPTY target. Detached descendants inherit that Job as well.
import { spawn } from "@lydell/node-pty";
import { z } from "zod";

const literal = z
  .string()
  .max(32_767)
  .refine((value) => !value.includes("\0"));
const [command, ...args] = z
  .tuple([literal.min(1)])
  .rest(literal)
  .parse(process.argv.slice(2));
const terminal = spawn(command, args, {
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)),
  name: "xterm-256color",
  cols: 1024,
  rows: 40,
});
terminal.onData((bytes) => {
  if (!process.stdout.write(bytes)) terminal.pause();
});
process.stdout.on("drain", () => terminal.resume());
terminal.onExit((event) => {
  process.exitCode = event.exitCode;
});
