// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { ensureInstallRootKey, writeSecretTextFile } from "@omnesis/core";

const tools = resolve("scripts/install-e2e/macos-variants-tools.py");
function python(program) {
  return spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `import importlib.util\ns=importlib.util.spec_from_file_location('tools',${JSON.stringify(tools)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n${program}`,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("disposable macOS installer variants", () => {
  test("actual installer diagnostics redact only bounded allowlisted tails after restoration", () => {
    const source = readFileSync("scripts/install-e2e/macos-variants.sh", "utf8");
    const extracted = source.match(
      /(^installer_failure_diagnostics\(\) \{\n[\s\S]*?\n\})\ncleanup\(\) \{/m,
    );
    expect(extracted).not.toBeNull();
    const directory = mkdtempSync(join(tmpdir(), "macos-diagnostic-tail-"));
    const registered = "registered-diagnostics-fictional-secret";
    const bearer = "fictional-diagnostic-bearer-secret";
    const product = "omn_fixture_abcdefghijklmnopqrstuvwxyz012345";
    const fragment = "long-token-fragment-must-not-escape";
    const labels = ["client", "absence", "no-service"];
    const secretFile = join(directory, "secrets");
    writeFileSync(secretFile, registered + "\n");
    const log =
      Array.from({ length: 60 }, (_, i) => `ordinary line ${i}`).join("\n") +
      `\n${"x".repeat(10000)}\nBearer ${bearer}\n${registered}\n${product}\nAuthorization: Bearer ${"a".repeat(10000)}-${fragment}\n`;
    for (const label of labels) writeFileSync(join(directory, `${label}.private.log`), log);
    for (const label of ["gateway", "collector"])
      writeFileSync(join(directory, `${label}.private.log`), "DAEMON-LOG-CANARY-NEVER-PRINT");
    function execute(restored, stub = "") {
      return spawnSync(
        "bash",
        [
          "-c",
          `set -uo pipefail
redact() { node "$REDACTOR"; }
${stub}
${extracted[1]}
status=23
installer_failure_diagnostics "$RESTORED"
exit "$status"
`,
        ],
        {
          env: {
            ...process.env,
            SESSION: directory,
            REDACTOR: resolve("scripts/install-e2e/redact.mjs"),
            RESTORED: restored,
            INSTALL_E2E_SECRETS_FILE: secretFile,
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
    }
    function assertPrivate(result, allowedLabels) {
      expect(result.status, result.stderr).toBe(23);
      expect(result.stdout).toBe("");
      for (const canary of [
        registered,
        bearer,
        product,
        fragment,
        "DAEMON-LOG-CANARY",
        "SYMLINK-LOG-CANARY",
        "NODE-MUST-NOT-RUN",
      ])
        expect(result.stderr).not.toContain(canary);
      const headings = allowedLabels
        .map((label) => `[install-e2e] redacted ${label} installer tail\n`)
        .join("");
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
        allowedLabels.length * 8192 + Buffer.byteLength(headings),
      );
    }
    try {
      for (const control of [
        { name: "restored", restored: "1", stub: "" },
        {
          name: "restore-failed",
          restored: "0",
          stub: "node() { echo NODE-MUST-NOT-RUN >&2; return 127; }",
        },
        { name: "node-unavailable", restored: "1", stub: "node() { return 127; }" },
        { name: "redactor-unavailable", restored: "1", stub: "redact() { return 127; }" },
      ]) {
        const result = execute(control.restored, control.stub);
        if (control.name === "restored") {
          assertPrivate(result, labels);
          expect(result.stderr).toContain("Bearer ***");
          expect(result.stderr).toContain("omn_***");
          expect(result.stderr).toContain("\n***\n");
        } else {
          expect(result.status).toBe(23);
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe(
            "[install-e2e] installer diagnostics unavailable after restoration\n",
          );
        }
      }
      writeFileSync(join(directory, "forbidden-log"), "SYMLINK-LOG-CANARY-NEVER-PRINT");
      rmSync(join(directory, "no-service.private.log"));
      symlinkSync(join(directory, "forbidden-log"), join(directory, "no-service.private.log"));
      const symlink = execute("1");
      assertPrivate(symlink, ["client", "absence"]);
      expect(symlink.stderr).not.toContain("redacted no-service installer tail");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses local, self-hosted, spoofed-Linux and malformed hosted identities before mutation", () => {
    const result = python(`
env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'macOS','HOME':'/Users/runner','ImageOS':'macos15','RUNNER_TEMP':'/Users/runner/work/_temp','GITHUB_WORKSPACE':'/Users/runner/work/project/project'}
assert str(m.hosted_guard(env,'Darwin'))=='/Users/runner/work/_temp'
for changes,system in [({},'Linux'),({'GITHUB_ACTIONS':'false'},'Darwin'),({'RUNNER_ENVIRONMENT':'self-hosted'},'Darwin'),({'HOME':'/Users/fictional'},'Darwin'),({'RUNNER_TEMP':'/'},'Darwin'),({'ImageOS':''},'Darwin')]:
 try:m.hosted_guard(env|changes,system)
 except RuntimeError:pass
 else:raise AssertionError('unsafe runner admitted')
for path in ['/etc/node','/Users/runner/runners/externals/node24/bin/node','/Users/runner/work/runner/externals/node24/bin/node','/Users/runner/work/../runners/externals/node24/bin/node']:
 try:m.tool_scope(m.Path(path),m.Path('/Users/runner/work/_temp'))
 except RuntimeError:pass
 else:raise AssertionError('runner engine admitted')
from unittest.mock import patch
with patch.object(m.Path,'resolve',return_value=m.Path('/Users/runner/agents/externals/node24/bin')):
 try:m.tool_scope(m.Path('/Users/runner/work/alias/node'),m.Path('/Users/runner/work/_temp'))
 except RuntimeError:pass
 else:raise AssertionError('symlinked parent escaped into runner engine')
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("restores exact original formula, symlink and binary; removes only recorded fresh replacements", () => {
    const result = python(`
import tempfile
with tempfile.TemporaryDirectory() as temporary:
 root=m.Path(temporary);backup=root/'backup';backup.mkdir()
 formula=root/'node@24';formula.mkdir();(formula/'original').write_text('original')
 binary=root/'node';binary.write_text('binary');binary.chmod(0o751)
 link=root/'link';link.symlink_to(formula)
 untouched=root/'unrelated';untouched.write_text('untouched')
 journal=m.Journal(backup);journal.move(formula,generated=True);journal.move(link,generated=True);journal.move(binary)
 formula.mkdir();(formula/'fresh').write_text('fresh');link.symlink_to(formula)
 m.Journal(backup).restore();m.Journal(backup).restore()
 assert (formula/'original').read_text()=='original' and not (formula/'fresh').exists()
 assert link.is_symlink() and link.readlink()==formula
 assert binary.read_text()=='binary' and binary.stat().st_mode & 0o777==0o751
 assert untouched.read_text()=='untouched'
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("journal intent survives failed move and restoration refuses an unexpected binary replacement", () => {
    const result = python(`
import tempfile
from unittest.mock import patch
with tempfile.TemporaryDirectory() as temporary:
 root=m.Path(temporary);backup=root/'backup';backup.mkdir();binary=root/'node';binary.write_text('original')
 journal=m.Journal(backup)
 with patch.object(m.Path,'rename',side_effect=OSError('injected move failure')):
  try:journal.move(binary)
  except OSError:pass
 m.Journal(backup).restore();assert binary.read_text()=='original'
 backup2=root/'backup2';backup2.mkdir();journal=m.Journal(backup2);journal.move(binary)
 binary.write_text('unexpected')
 try:journal.restore()
 except RuntimeError:pass
 else:raise AssertionError('overwrote an unowned replacement')
 assert binary.read_text()=='unexpected' and (backup2/'tool-0').read_text()=='original'
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("an interrupted restore is idempotent and an originally absent generated formula is retired", () => {
    const result = python(`
import tempfile
with tempfile.TemporaryDirectory() as temporary:
 root=m.Path(temporary);backup=root/'backup';backup.mkdir();binary=root/'node';binary.write_text('original')
 journal=m.Journal(backup);journal.move(binary)
 (backup/'tool-0').rename(binary)
 m.Journal(backup).restore();assert binary.read_text()=='original'
 backup2=root/'backup2';backup2.mkdir();formula=root/'node@24'
 journal=m.Journal(backup2);journal.move(formula,generated=True)
 formula.mkdir();(formula/'fresh').write_text('fresh')
 journal.restore();assert not formula.exists()
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("missing journals and changed backup/original identities cannot prove restoration", () => {
    const result = python(`
import tempfile
with tempfile.TemporaryDirectory() as temporary:
 root=m.Path(temporary);backup=root/'backup';backup.mkdir();binary=root/'node';binary.write_text('original')
 try:m.Journal(backup).restore()
 except RuntimeError:pass
 else:raise AssertionError('missing journal counted as restored')
 journal=m.Journal(backup);journal.move(binary)
 journal.file.unlink()
 try:m.Journal(backup).restore()
 except RuntimeError:pass
 else:raise AssertionError('lost journal counted as restored')
 assert (backup/'tool-0').read_text()=='original'
 journal.save();(backup/'tool-0').write_text('corrupted backup')
 try:m.Journal(backup).restore()
 except RuntimeError:pass
 else:raise AssertionError('changed backup identity accepted')
 assert (backup/'tool-0').exists() and not binary.exists()
with tempfile.TemporaryDirectory() as temporary:
 root=m.Path(temporary);backup=root/'backup';backup.mkdir();binary=root/'node';binary.write_text('original')
 journal=m.Journal(backup);journal.move(binary);journal.restore()
 binary.unlink();binary.write_text('replacement')
 try:m.Journal(backup).restore()
 except RuntimeError:pass
 else:raise AssertionError('changed restored identity accepted')
 assert binary.read_text()=='replacement'
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("the actual shell entry refuses self-hosted identities on every OS before creating evidence or quarantining tools", () => {
    const root = mkdtempSync(join(tmpdir(), "macos-variant-refusal-"));
    const work = join(root, "never-created");
    try {
      const result = spawnSync("bash", ["scripts/install-e2e/macos-variants.sh", "missing-node"], {
        env: {
          ...process.env,
          E2E_WORK: work,
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "self-hosted",
          RUNNER_OS: "macOS",
        },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("requires a disposable GitHub-hosted macOS runner");
      expect(() => readFileSync(join(work, "result.json"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime no-model proof rejects assigned roles and actual model artifacts", () => {
    const runtime = resolve("scripts/install-e2e/macos-variants-runtime.py");
    const result = python(`
import tempfile
s=importlib.util.spec_from_file_location('runtime',${JSON.stringify(runtime)});runtime=importlib.util.module_from_spec(s);s.loader.exec_module(runtime)
with tempfile.TemporaryDirectory() as temporary:
 root=m.Path(temporary);runtime.no_models(root)
 (root/'omnesis.json').write_text('{"inference":{"assignments":{"agent":"remote/fictional"}}}')
 try:runtime.no_models(root)
 except RuntimeError:pass
 else:raise AssertionError('assigned model admitted')
 (root/'omnesis.json').write_text('{}');(root/'models').mkdir();(root/'models/fictional.gguf').write_text('not a model')
 try:runtime.no_models(root)
 except RuntimeError:pass
 else:raise AssertionError('model artifact admitted')
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("reads a real wrapped credential through the production decoder without publishing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "macos-wrapped-credential-"));
    const token = "fictional-ci-bearer-not-for-a-service";
    try {
      await ensureInstallRootKey({ backend: "file", configDir: directory });
      await writeSecretTextFile(join(directory, "token"), token, {
        backend: "file",
        configDir: directory,
      });
      expect(JSON.parse(readFileSync(join(directory, "token"), "utf8")).omnesis).toBe(
        "omnesis.secret-file",
      );
      const runtime = resolve("scripts/install-e2e/macos-variants-runtime.py");
      const installSource = resolve(".");
      const result = python(`
import os
s=importlib.util.spec_from_file_location('runtime',${JSON.stringify(runtime)});runtime=importlib.util.module_from_spec(s);s.loader.exec_module(runtime)
os.environ['OMNESIS_SECRET_STORE']='file'
value=runtime.source_gateway_token(m.Path(${JSON.stringify(directory)}),m.Path(${JSON.stringify(installSource)}))
assert value==${JSON.stringify(token)}
print('decoded privately')
`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("decoded privately");
      expect(result.stdout + result.stderr).not.toContain(token);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("credential decoder failures discard partial secrets and cannot yield a bearer", () => {
    const runtime = resolve("scripts/install-e2e/macos-variants-runtime.py");
    const result = python(`
import os
from unittest.mock import patch
from types import SimpleNamespace
s=importlib.util.spec_from_file_location('runtime',${JSON.stringify(runtime)});runtime=importlib.util.module_from_spec(s);s.loader.exec_module(runtime)
os.environ['OMNESIS_SECRET_STORE']='file'
with patch.object(runtime.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout='partial-private-canary',stderr='private-canary')):
 try:runtime.gateway_token(m.Path('/fictional-config'),'file:///fictional-core.js')
 except RuntimeError as error:assert str(error)=='isolated gateway credential could not be read'
 else:raise AssertionError('failed credential decoder yielded a bearer')
print('refused privately')
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("private-canary");
  });

  test("a completed leader cannot leave a TERM-resistant grandchild running", () => {
    const directory = mkdtempSync(join(tmpdir(), "macos-command-group-"));
    const pidfile = join(directory, "grandchild.pid");
    const program = join(directory, "leader.py");
    writeFileSync(
      program,
      `import subprocess,sys,time\nfrom pathlib import Path\nchild=subprocess.Popen([sys.executable,'-c',${JSON.stringify("import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path(" + JSON.stringify(pidfile) + ").write_text(str(os.getpid()));time.sleep(60)")}])\nwhile not Path(${JSON.stringify(pidfile)}).exists():time.sleep(.01)\n`,
    );
    try {
      const command = resolve("scripts/install-e2e/macos-variants-command.py");
      const result = python(`
import sys
s=importlib.util.spec_from_file_location('command',${JSON.stringify(command)});command=importlib.util.module_from_spec(s);s.loader.exec_module(command)
assert command.supervise([sys.executable,${JSON.stringify(program)}],grace_seconds=.1)==0
pid=int(m.Path(${JSON.stringify(pidfile)}).read_text())
output=command.subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
assert output.returncode!=0 or output.stdout.strip().startswith('Z'),'grandchild remained runnable'
`);
      expect(result.status, result.stderr).toBe(0);
    } finally {
      try {
        const pid = Number(readFileSync(pidfile, "utf8"));
        const observed = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
          encoding: "utf8",
        });
        if (observed.stdout.includes(pidfile)) process.kill(pid, "SIGKILL");
      } catch {
        // The fixture process may already have exited before cleanup.
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("controller TERM waits for runtime cleanup of two separately owned daemon sessions", async () => {
    const { spawn } = await import("node:child_process");
    const directory = mkdtempSync(join(tmpdir(), "macos-runtime-cancel-"));
    const pidfile = join(directory, "daemons.json");
    const runtime = resolve("scripts/install-e2e/macos-variants-runtime.py");
    const driver = join(directory, "runtime.py");
    writeFileSync(
      driver,
      `import importlib.util,json,signal,subprocess,sys,time\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('runtime',${JSON.stringify(runtime)});runtime=importlib.util.module_from_spec(s);s.loader.exec_module(runtime)\ndef stop(*_):raise InterruptedError('cancelled')\nsignal.signal(signal.SIGTERM,stop)\nchildren=[]\ntry:\n for index in range(2):\n  ready=Path(${JSON.stringify(directory)})/('ready-'+str(index))\n  code='import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path('+repr(str(ready))+').write_text(str(os.getpid()));time.sleep(60)'\n  child=subprocess.Popen([sys.executable,'-c',code],start_new_session=True);children.append(child)\n  while not ready.exists():time.sleep(.01)\n Path(${JSON.stringify(pidfile)}).write_text(json.dumps([child.pid for child in children]))\n signal.pause()\nfinally:runtime.retire_children(children,grace_seconds=.1,force_seconds=1)\n`,
    );
    const child = spawn(
      "python3",
      ["-B", "scripts/install-e2e/macos-variants-command.py", "python3", driver],
      { stdio: "ignore" },
    );
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          JSON.parse(readFileSync(pidfile, "utf8"));
          break;
        } catch {
          // Wait until the child has published a complete readiness record.
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      const daemons = JSON.parse(readFileSync(pidfile, "utf8"));
      const ended = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      await ended;
      for (const pid of daemons) {
        const state = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
        expect(state.status !== 0 || state.stdout.trim().startsWith("Z")).toBe(true);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      try {
        for (const pid of JSON.parse(readFileSync(pidfile, "utf8"))) {
          const observed = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
          });
          if (observed.stdout.includes(directory)) process.kill(pid, "SIGKILL");
        }
      } catch {
        // The runtime may have exited before publishing daemon identities.
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the real command supervisor drains its exact child before returning on cancellation", async () => {
    const { spawn } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "macos-owned-command-"));
    const ready = join(root, "ready");
    const stopped = join(root, "stopped");
    const script = join(root, "child.py");
    writeFileSync(
      script,
      `import signal,time\nfrom pathlib import Path\ndef stop(*_):\n Path(${JSON.stringify(stopped)}).write_text('drained');raise SystemExit(0)\nsignal.signal(signal.SIGTERM,stop)\nPath(${JSON.stringify(ready)}).write_text('ready')\nwhile True:time.sleep(1)\n`,
    );
    const process = spawn(
      "python3",
      ["-B", "scripts/install-e2e/macos-variants-command.py", "python3", script],
      { stdio: "ignore" },
    );
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          if (readFileSync(ready, "utf8") === "ready") break;
        } catch {
          // Wait until the fixture child has published its readiness record.
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(readFileSync(ready, "utf8")).toBe("ready");
      const ended = new Promise((resolveExit) => process.once("exit", resolveExit));
      process.kill("SIGTERM");
      await ended;
      expect(readFileSync(stopped, "utf8")).toBe("drained");
    } finally {
      if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
