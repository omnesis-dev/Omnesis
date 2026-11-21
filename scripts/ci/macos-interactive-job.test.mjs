// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./macos-interactive-job.sh", import.meta.url));
const sandboxes = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A sandbox whose PATH reports macOS and holds a `launchctl` that does what
 * launchd does with the job: `bootstrap` starts the plist's program with its
 * output in the plist's log and records the plist, `print` tells a running job
 * from one that has exited, and `bootout` ends it.
 */
function sandbox() {
  // The job reports its working directory as `pwd` resolves it. On macOS the
  // temporary directory is reached through the /var -> /private/var symlink, so
  // the sandbox is named by its resolved path for the comparison to hold.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-interactive-job-")));
  sandboxes.push(dir);
  const bin = join(dir, "bin");
  const state = join(dir, "launchd");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n");
  writeFileSync(
    join(bin, "launchctl"),
    `#!/usr/bin/env bash
state=${JSON.stringify(state)}
echo "$*" >>"$state/calls"
case "$1" in
  bootstrap)
    cp "$3" "$state/job.plist"
    python3 - "$3" >"$state/argv" <<'PY'
import plistlib, sys
job = plistlib.load(open(sys.argv[1], "rb"))
print("\\0".join(job["ProgramArguments"]), end="")
PY
    log="$(python3 -c 'import plistlib, sys; print(plistlib.load(open(sys.argv[1], "rb"))["StandardOutPath"])' "$3")"
    # Start the program detached, as launchd would, outside the caller's group.
    python3 - "$state" "$log" <<'PY'
import os, subprocess, sys
state, log = sys.argv[1], sys.argv[2]
argv = open(os.path.join(state, "argv")).read().split("\\0")
out = open(log, "ab")
proc = subprocess.Popen(argv, stdout=out, stderr=out, stdin=subprocess.DEVNULL, start_new_session=True)
open(os.path.join(state, "pid"), "w").write(str(proc.pid))
PY
    ;;
  print)
    pid="$(cat "$state/pid" 2>/dev/null)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && ! grep -q Z <(ps -o stat= -p "$pid"); then
      printf '\\tstate = running\\n\\tpid = %s\\n' "$pid"
    else
      printf '\\tstate = not running\\n'
    fi
    ;;
  bootout)
    pid="$(cat "$state/pid" 2>/dev/null)"
    [[ -n "$pid" ]] && kill -TERM -- "-$pid" 2>/dev/null
    ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "uname"), 0o755);
  chmodSync(join(bin, "launchctl"), 0o755);
  return { dir, bin, state };
}

function run(box, args, env = {}) {
  return spawnSync("bash", [script, ...args], {
    cwd: box.dir,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: `${box.bin}:${process.env.PATH}`,
      HOME: box.dir,
      RUNNER_TEMP: box.dir,
      ...env,
    },
  });
}

describe("scripts/ci/macos-interactive-job.sh", () => {
  it("runs the command as an Interactive launchd job with this shell's environment and directory", () => {
    const box = sandbox();
    const result = run(
      box,
      ["bash", "-c", 'echo "arg=$1 env=$JOURNEY_PROBE cwd=$(pwd)"; exit 3', "_", "two words"],
      { JOURNEY_PROBE: 'it\'s "quoted"' },
    );
    expect(result.stdout).toContain(`arg=two words env=it's "quoted" cwd=${box.dir}`);
    expect(result.status).toBe(3);
    const plist = readFileSync(join(box.state, "job.plist"), "utf8");
    expect(plist).toMatch(/<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
    const calls = readFileSync(join(box.state, "calls"), "utf8");
    expect(calls).toMatch(/^bootstrap gui\/\d+ /m);
    expect(calls).toMatch(/^bootout gui\/\d+\/dev\.omnesis\.ci\./m);
  });

  it("passes a successful command's status through", () => {
    const box = sandbox();
    const result = run(box, ["true"]);
    expect(result.status).toBe(0);
  });

  it("fails when the job ends without reporting a status", () => {
    const box = sandbox();
    // The job kills its own shell before that shell can record a status.
    const result = run(box, ["bash", "-c", "kill -KILL $PPID"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ended without reporting a status");
  });

  it("runs the command in the foreground anywhere but macOS", () => {
    const box = sandbox();
    writeFileSync(join(box.bin, "uname"), "#!/bin/sh\necho Linux\n");
    const result = run(box, ["bash", "-c", "echo direct; exit 4"]);
    expect(result.stdout).toContain("direct");
    expect(result.status).toBe(4);
    expect(() => readFileSync(join(box.state, "calls"), "utf8")).toThrow();
  });
});
