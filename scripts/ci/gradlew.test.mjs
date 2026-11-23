// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const SCRIPT = join(import.meta.dirname, "gradlew.sh");
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function executable(file, body) {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/**
 * A thread dump as `jcmd <pid> Thread.print` prints it: the build's worker
 * reading a repository's response, Gradle's own file-lock listener on a
 * socket, and an idle JVM thread.
 */
const THREAD_DUMP = `Full thread dump:

"Daemon worker" #42 prio=5 os_prio=0 tid=0x1 nid=0x2 runnable
   java.lang.Thread.State: RUNNABLE
\tat sun.nio.ch.NioSocketImpl.park(NioSocketImpl.java:191)
\tat java.net.Socket$SocketInputStream.read(Socket.java:1099)
\tat org.gradle.internal.resource.transport.http.HttpClientHelper.performRequest(HttpClientHelper.java:118)

"File lock request listener" #36 prio=5 os_prio=0 tid=0x5 nid=0x6 runnable
   java.lang.Thread.State: RUNNABLE
\tat java.net.DatagramSocket.receive(DatagramSocket.java:700)

"Common-Cleaner" #12 daemon prio=8 os_prio=0 tid=0x3 nid=0x4 in Object.wait()
   java.lang.Thread.State: TIMED_WAITING (on object monitor)
\tat java.lang.Object.wait(Object.java:338)
`;

/**
 * Runs the script in a directory whose `gradlew` prints its arguments, then
 * waits for `waitFor` to exist (when given) before printing a task line and
 * exiting with `status`. A fake JDK's `jcmd` lists a Gradle daemon and a Kotlin
 * daemon, records each call and creates `dumped` when asked for a thread dump.
 */
function run({ status = 0, quiet = false, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-ci-gradlew-"));
  dirs.push(dir);
  const calls = join(dir, "jcmd-calls");
  const dumped = join(dir, "dumped");
  const dump = join(dir, "thread-dump.txt");
  writeFileSync(dump, THREAD_DUMP);
  mkdirSync(join(dir, "jdk", "bin"), { recursive: true });
  executable(
    join(dir, "jdk", "bin", "jcmd"),
    `echo "$*" >> "${calls}"
if [ "$1" = "-l" ]; then
  echo "4242 org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.11.1"
  echo "4243 org.jetbrains.kotlin.daemon.KotlinCompileDaemon"
  echo "4244 jdk.jcmd/sun.tools.jcmd.JCmd -l"
else
  cat "${dump}"
  touch "${dumped}"
fi`,
  );
  // The fake build goes quiet until the script has reported it, then
  // finishes. The bound only keeps a broken script from hanging the test.
  const wait = quiet
    ? `i=0; while [ ! -e "${dumped}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i + 1)); done`
    : "";
  executable(
    join(dir, "gradlew"),
    `echo "gradlew $*"\n${wait}\necho "> Task :app:test"\nexit ${status}`,
  );
  const result = spawnSync("bash", [SCRIPT, ":app:test", "--no-daemon"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      JAVA_HOME: join(dir, "jdk"),
      ...env,
    },
  });
  let jcmd = [];
  try {
    jcmd = readFileSync(calls, "utf8").trim().split("\n");
  } catch {
    // jcmd was never called.
  }
  return { ...result, jcmd };
}

describe("scripts/ci/gradlew.sh", () => {
  test("runs the wrapper with its arguments and exits with its status", () => {
    const ok = run();
    expect(ok.stdout).toContain("gradlew :app:test --no-daemon\n");
    expect(ok.status).toBe(0);
    expect(run({ status: 3 }).status).toBe(3);
  });

  test("resolves offline only when the cache is the exact entry", () => {
    expect(run().stdout).not.toContain("--offline");
    expect(run({ env: { OMNESIS_GRADLE_OFFLINE: "false" } }).stdout).not.toContain("--offline");
    const offline = run({ env: { OMNESIS_GRADLE_OFFLINE: "true" } });
    expect(offline.stdout).toContain("resolving offline");
    expect(offline.stdout).toContain("gradlew :app:test --no-daemon --offline\n");
  });

  test("prints nothing extra and dumps no thread while Gradle keeps printing", () => {
    const result = run();
    expect(result.stdout).not.toContain("::warning::");
    expect(result.jcmd).toEqual([]);
  });

  test("reports the Gradle threads on the network when Gradle goes quiet", () => {
    const result = run({ quiet: true, env: { OMNESIS_GRADLE_QUIET_SECONDS: "1" } });
    expect(result.status).toBe(0);
    const out = result.stdout;
    const warning = out.indexOf("::warning::Gradle has printed nothing for");
    expect(warning).toBeGreaterThan(out.indexOf("gradlew :app:test"));
    expect(out.indexOf("> Task :app:test")).toBeGreaterThan(warning);
    expect(out).toContain("--- GradleDaemon (pid 4242) ---");
    expect(out).toContain("HttpClientHelper.performRequest");
    expect(out).not.toContain("Common-Cleaner");
    expect(out).not.toContain("File lock request listener");
    // Only the Gradle daemon is dumped, not the Kotlin daemon or jcmd itself.
    expect(result.jcmd.filter((call) => call !== "-l")).toEqual(
      result.jcmd.filter((call) => call !== "-l").map(() => "4242 Thread.print"),
    );
    expect(result.jcmd).toContain("4242 Thread.print");
  });
});
