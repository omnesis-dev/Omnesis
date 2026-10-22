// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Run both daemons as one failure domain. Docker owns restart policy. */
export async function supervise({
  gateway = [process.execPath, "/app/packages/gateway/dist/index.js"],
  collector = [process.execPath, "/app/packages/collector/dist/main.js"],
  drainMs = 40_000,
} = {}) {
  process.umask(0o077);
  const children = [];
  let stopping = false;
  let finish;
  const result = new Promise((resolve) => {
    finish = resolve;
  });
  function signal(child, value) {
    if (!child.pid) return;
    try {
      // Each daemon owns a process group, including its auth/worker children.
      process.kill(-child.pid, value);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  async function stopChild(child) {
    signal(child, "SIGTERM");
    let timer;
    await Promise.race([
      child.done,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          signal(child, "SIGKILL");
          resolve();
        }, drainMs);
      }),
    ]);
    clearTimeout(timer);
    // The daemon can exit while an auth subprocess remains in its group.
    signal(child, "SIGKILL");
    await child.done;
  }
  async function stop(code) {
    if (stopping) return;
    stopping = true;
    // Keep the gateway available while the collector flushes pages/cursors.
    for (const child of [...children].reverse()) await stopChild(child);
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
    finish(code);
  }
  const onTerm = () => {
    void stop(0);
  };
  const onInt = () => {
    void stop(0);
  };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  for (const [name, command] of [
    ["gateway", gateway],
    ["collector", collector],
  ]) {
    const child = spawn(command[0], command.slice(1), {
      detached: true,
      stdio: "inherit",
      env:
        name === "collector"
          ? {
              ...process.env,
              OMNESIS_GATEWAY_URL:
                process.env.OMNESIS_GATEWAY_URL ||
                `https://localhost:${process.env.OMNESIS_GATEWAY_PORT || "7600"}`,
            }
          : process.env,
    });
    child.done = new Promise((resolve) => {
      child.once("error", (error) => {
        process.stderr.write(`[docker] ${name} could not start: ${error.message}\n`);
        resolve();
        void stop(1);
      });
      child.once("exit", (code, sig) => {
        resolve();
        if (!stopping) {
          process.stderr.write(`[docker] ${name} exited (${sig || code}); stopping container\n`);
          // A daemon exiting successfully still leaves an incomplete service.
          void stop(code || 1);
        }
      });
    });
    children.push(child);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await supervise();
}
