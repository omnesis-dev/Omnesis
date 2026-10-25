#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signalOwnedProcess } from "./update-fault.mjs";

/** Called before mkdir, DNS, hosts, sudo, Docker or service operations. */
export function validateHost(
  env,
  work,
  source,
  role,
  { platform = process.platform, fs = { lstatSync, realpathSync } } = {},
) {
  const mac = role === "mac";
  if (
    !["mac", "linux"].includes(role) ||
    platform !== (mac ? "darwin" : "linux") ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.RUNNER_OS !== (mac ? "macOS" : "Linux") ||
    env.HOME !== (mac ? "/Users/runner" : "/home/runner") ||
    !env.ImageOS?.startsWith(mac ? "macos" : "ubuntu")
  )
    throw new Error("T3 requires an actual disposable GitHub-hosted runner");
  const base = env.HOME + "/work/";
  for (const key of ["RUNNER_TEMP", "GITHUB_WORKSPACE"]) {
    if (
      !env[key]?.startsWith(base) ||
      resolve(env[key]) !== env[key] ||
      fs.realpathSync(env[key]) !== env[key]
    )
      throw new Error("T3 requires canonical hosted workspace/temp");
  }
  if (
    fs.realpathSync(env.HOME) !== env.HOME ||
    resolve(source) !== source ||
    source !== env.GITHUB_WORKSPACE ||
    !work ||
    resolve(work) !== work ||
    !work.startsWith(env.RUNNER_TEMP + "/")
  )
    throw new Error("T3 source and scratch must belong to the disposable runner");
  for (const target of [
    work,
    source,
    env.HOME + "/.config/omnesis",
    env.HOME + "/.local/bin/omnesis",
    env.HOME + "/omnesis",
  ]) {
    for (let path = target; path !== dirname(path); path = dirname(path)) {
      try {
        if (fs.lstatSync(path).isSymbolicLink())
          throw new Error("T3 rejects symlinked owned paths");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return true;
}

function alive(record) {
  try {
    const text = readFileSync(`/proc/${record.pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return fields[19] === record.started && fields[0] !== "Z";
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

/** Retire only the recorded mailbox birth; a reused PID is never signalled. */
export async function stopMailbox(record) {
  if (
    !Number.isInteger(record?.pid) ||
    record.pid <= 0 ||
    typeof record.started !== "string" ||
    !/^[0-9]+$/.test(record.started)
  )
    throw new Error("invalid owned mailbox process record");
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (!alive(record)) return;
    signalOwnedProcess(record.pid, record.started, signal);
    const deadline = Date.now() + 3000;
    while (alive(record) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 25));
  }
  if (alive(record)) throw new Error("owned mailbox did not retire");
}

async function main([command, ...args]) {
  if (command === "guard") return validateHost(process.env, args[1], args[2], args[0]);
  if (command === "stop-mailbox") return stopMailbox(JSON.parse(readFileSync(args[0], "utf8")));
  throw new Error("unknown Docker tailnet host command");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    console.error("T3 host ownership assertion failed");
    process.exit(1);
  });
}
