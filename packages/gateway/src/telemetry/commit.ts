// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const shaPattern = /^[a-f0-9]{40}$/;
const UPSTREAM = "https://github.com/omnesis-dev/Omnesis.git";

/** Never query a server with an unknown local SHA: that alone could leak fork history. */
export async function publicGatewayCommit(signal: AbortSignal): Promise<string> {
  const directory = fileURLToPath(new URL("../", import.meta.url));
  try {
    // Published builds include only a SHA proved public during packaging.
    const artifact = JSON.parse(
      await readFile(new URL("../telemetry-build.json", import.meta.url), "utf8"),
    ) as { gitCommit?: unknown };
    if (artifact.gitCommit === "custom") return "custom";
    if (typeof artifact.gitCommit === "string" && shaPattern.test(artifact.gitCommit)) {
      return artifact.gitCommit;
    }
  } catch {
    /* A source checkout has no build artifact. */
  }
  // A packaged module without provenance must not borrow an enclosing checkout's SHA.
  if (!import.meta.url.endsWith(".ts")) return "custom";
  const options = {
    cwd: directory,
    timeout: 1_500,
    maxBuffer: 65_536,
    signal,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull,
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_GRAFT_FILE: devNull,
    },
  };
  let remoteDirectory: string | undefined;
  try {
    const local = (await run("git", ["rev-parse", "HEAD"], options)).stdout.trim();
    if (!shaPattern.test(local)) return "custom";
    const status = await run("git", ["status", "--porcelain", "--untracked-files=normal"], options);
    if (status.stdout.trim()) return "custom";
    // Tags cover shallow and single-branch source installations without fetching
    // objects or mutating the checkout. The request contains no local SHA.
    // Git URL rewrites and local transport helpers must not turn a request for
    // public refs into a private repository lookup. No repository/config is inherited.
    remoteDirectory = await mkdtemp(join(tmpdir(), "omnesis-public-refs-"));
    const advertised = (
      await run("git", ["ls-remote", UPSTREAM, "refs/heads/main", "refs/tags/*"], {
        ...options,
        cwd: remoteDirectory,
        env: { ...options.env, GIT_CEILING_DIRECTORIES: tmpdir() },
      })
    ).stdout;
    let main: string | undefined;
    for (const line of advertised.split("\n")) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (!sha || !shaPattern.test(sha) || !ref) continue;
      if (ref === "refs/heads/main") main = sha;
      if ((ref === "refs/heads/main" || ref.startsWith("refs/tags/")) && local === sha)
        return local;
    }
    if (!main) return "custom";
    await run("git", ["merge-base", "--is-ancestor", local, main], options);
    return local;
  } catch {
    return "custom";
  } finally {
    if (remoteDirectory)
      await rm(remoteDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
