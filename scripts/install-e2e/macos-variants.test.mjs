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
  test("nested redirected installer failure restores the console before redacted diagnostics", () => {
    const source = readFileSync("scripts/install-e2e/macos-variants.sh", "utf8");
    const diagnostics = source.match(
      /(^installer_failure_diagnostics\(\) \{\n[\s\S]*?\n\})\ncleanup\(\) \{/m,
    )[1];
    const cleanupPrefix = source.match(/(^cleanup\(\) \{\n[\s\S]*? {2}set \+e\n)/m)[1];
    const preserve = source.match(/^(exec 3>&1 4>&2)\ntrap cleanup EXIT/m)[1];
    const directory = mkdtempSync(join(tmpdir(), "macos-nested-diagnostic-"));
    const secret = "fictional-nested-installer-credential";
    const secretFile = join(directory, "secrets");
    writeFileSync(secretFile, secret + "\n");
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
redact() { node "$REDACTOR"; }
${diagnostics}
${cleanupPrefix}
installer_failure_diagnostics "$restored"
exit "$status"
}
${preserve}
trap cleanup EXIT
installer() { printf 'Bearer %s\\n' "$CANARY"; return 23; }
nested() { installer; }
nested >"$SESSION/client.private.log" 2>&1
`,
        ],
        {
          env: {
            ...process.env,
            SESSION: directory,
            PYTHON: "python3",
            REDACTOR: resolve("scripts/install-e2e/redact.mjs"),
            CANARY: secret,
            INSTALL_E2E_SECRETS_FILE: secretFile,
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.status, result.stderr).toBe(23);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("redacted client installer tail");
      expect(result.stderr).toContain("Bearer ***");
      expect(result.stderr).not.toContain(secret);
      expect(readFileSync(join(directory, "client.private.log"), "utf8")).not.toContain(
        "installer tail",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("only first-cycle pre-source gateway failure permits a bounded redacted daemon tail", () => {
    const source = readFileSync("scripts/install-e2e/macos-variants.sh", "utf8");
    const diagnostics = source.match(
      /(^installer_failure_diagnostics\(\) \{\n[\s\S]*?\n\})\ncleanup\(\) \{/m,
    )[1];
    const directory = mkdtempSync(join(tmpdir(), "macos-startup-diagnostic-"));
    const secret = "fictional-startup-credential";
    const secretFile = join(directory, "secrets");
    const marker = join(directory, "startup-failure.json");
    const gateway = join(directory, "gateway.private.log");
    writeFileSync(secretFile, secret + "\n");
    writeFileSync(
      gateway,
      `Bearer ${secret}\n${"x".repeat(10000)}\n${"omn_fixture_abcdefghijklmnopqrstuvwxyz012345"}\n`,
    );
    writeFileSync(join(directory, "collector.private.log"), "COLLECTOR-PRIVATE-CANARY");
    function execute() {
      return spawnSync(
        "bash",
        [
          "-c",
          `set -uo pipefail
redact() { node "$REDACTOR"; }
${diagnostics}
installer_failure_diagnostics 1
exit 23
`,
        ],
        {
          env: {
            ...process.env,
            SESSION: directory,
            PYTHON: "python3",
            REDACTOR: resolve("scripts/install-e2e/redact.mjs"),
            INSTALL_E2E_SECRETS_FILE: secretFile,
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
    }
    try {
      for (const body of [
        null,
        { phase: "gateway-health", cycle: 2, before_sources: true },
        { phase: "collector-online", cycle: 1, before_sources: true },
        { phase: "gateway-health", cycle: 1, before_sources: false },
      ]) {
        if (body) writeFileSync(marker, JSON.stringify(body));
        const result = execute();
        expect(result.status).toBe(23);
        expect(result.stdout + result.stderr).toBe("");
      }
      writeFileSync(
        marker,
        JSON.stringify({ phase: "gateway-health", cycle: 1, before_sources: true }),
      );
      const allowed = execute();
      expect(allowed.status).toBe(23);
      expect(allowed.stdout).toBe("");
      expect(allowed.stderr).toContain("redacted gateway pre-readiness tail");
      for (const canary of [secret, "omn_fixture_", "COLLECTOR-PRIVATE-CANARY"])
        expect(allowed.stderr).not.toContain(canary);
      expect(Buffer.byteLength(allowed.stderr)).toBeLessThanOrEqual(
        8192 + Buffer.byteLength("[install-e2e] redacted gateway pre-readiness tail\n"),
      );
      rmSync(gateway);
      symlinkSync(join(directory, "collector.private.log"), gateway);
      expect(execute().stderr).toBe("");
      rmSync(marker);
      writeFileSync(
        gateway + ".marker",
        JSON.stringify({ phase: "gateway-health", cycle: 1, before_sources: true }),
      );
      symlinkSync(gateway + ".marker", marker);
      expect(execute().stderr).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("artifact summary accepts only fixed native probe stages and numeric statuses", () => {
    const source = readFileSync("scripts/install-e2e/macos-variants.sh", "utf8");
    const writer = source.match(
      /(^write_result\(\) \{\n[\s\S]*?\n\})\ninstaller_failure_diagnostics/m,
    )[1];
    const directory = mkdtempSync(join(tmpdir(), "macos-probe-summary-"));
    const stages = [
      "sqlite-import",
      "duckdb-import",
      "usearch-import",
      "sqlite-encrypted",
      "usearch-empty",
      "duckdb-memory",
      "duckdb-encrypted",
    ];
    const rows = stages.map((stage) => ({ stage, exit: 0, signal: null, timeout: false }));
    try {
      for (const [candidate, valid] of [
        [rows, true],
        [[{ ...rows[0], stage: "private-canary" }, ...rows.slice(1)], false],
        [[{ ...rows[0], exit: "private-canary" }, ...rows.slice(1)], false],
        [[{ ...rows[0], raw: "private-canary" }, ...rows.slice(1)], false],
      ]) {
        writeFileSync(join(directory, "native-startup-probes.json"), JSON.stringify(candidate));
        const result = spawnSync("bash", ["-c", `${writer}\nwrite_result 1`], {
          env: {
            ...process.env,
            PYTHON: "python3",
            E2E_WORK: directory,
            SESSION: directory,
            HERE: resolve("scripts/install-e2e"),
            MODE: "isolation",
            PHASE: "foreground-restart-and-raw-data",
            COMMIT: "0".repeat(40),
          },
          encoding: "utf8",
          timeout: 10000,
        });
        expect(result.status, result.stderr).toBe(0);
        const summary = readFileSync(join(directory, "result.json"), "utf8");
        expect(summary).not.toContain("private-canary");
        expect(Object.hasOwn(JSON.parse(summary), "native_startup_probes")).toBe(valid);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("actual scrubbed child environment restricts cascading Brew upgrades and drops ambient credentials", () => {
    const source = readFileSync("scripts/install-e2e/macos-variants.sh", "utf8");
    const command = source.match(/(^child_command\(\) \{\n[\s\S]*?\n\})\ninstall_client/m)[1];
    const directory = mkdtempSync(join(tmpdir(), "macos-scrubbed-child-"));
    try {
      const result = spawnSync(
        "bash",
        ["-c", `${command}\nchild_command "$SESSION" /usr/bin/env`],
        {
          env: {
            ...process.env,
            PYTHON: "python3",
            SESSION: directory,
            HERE: resolve("scripts/install-e2e"),
            ORIGINAL_PATH: process.env.PATH,
            PORT: "19999",
            ANTHROPIC_API_KEY: "fictional-ambient-canary",
            OPENAI_API_KEY: "fictional-ambient-canary",
            OMNESIS_TOKEN: "fictional-ambient-canary",
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const lines = result.stdout.split("\n");
      expect(lines).toContain("HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1");
      expect(lines).toContain("HOMEBREW_NO_AUTO_UPDATE=1");
      expect(lines).toContain("HOMEBREW_NO_INSTALL_CLEANUP=1");
      expect(lines).toContain("OMNESIS_SECRET_STORE=file");
      expect(result.stdout + result.stderr).not.toContain("fictional-ambient-canary");
      expect(
        lines.some((line) => /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|OMNESIS_TOKEN)=/.test(line)),
      ).toBe(false);
      expect(lines.some((line) => line.startsWith("HOMEBREW_NO_INSTALL_UPGRADE="))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
            PYTHON: "python3",
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

  test("native crash diagnostics run only before first-cycle sources and cannot replace failure", () => {
    const runtime = resolve("scripts/install-e2e/macos-variants-runtime.py");
    const result = python(`
import tempfile
s=importlib.util.spec_from_file_location('runtime',${JSON.stringify(runtime)});runtime=importlib.util.module_from_spec(s);s.loader.exec_module(runtime)
with tempfile.TemporaryDirectory() as temporary:
 work=m.Path(temporary);calls=[]
 def probe(source,directory):calls.append((source,directory));return []
 for code,cycle in [(0,1),(1,1),(143,1),(139,2),(-11,2),(None,1)]:runtime.record_native_startup_probes(work,work/'source',code,cycle,probe)
 assert calls==[] and not (work/'native-startup-probes.json').exists()
 for code in (139,-11):runtime.record_native_startup_probes(work,work/'source',code,1,probe)
 assert calls==[(work/'source',work)]*2
 def broken(*_):raise ValueError('private-exception-text')
 try:
  try:raise RuntimeError('original readiness failure')
  except RuntimeError:
   runtime.record_native_startup_probes(work,work/'source',139,1,broken)
   raise
 except RuntimeError as error:assert str(error)=='original readiness failure'
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("gateway health uses the declared finite positive shared boot budget", () => {
    const runtime = resolve("scripts/install-e2e/macos-variants-runtime.py");
    const result = python(`
import json,unittest.mock
s=importlib.util.spec_from_file_location('runtime',${JSON.stringify(runtime)});runtime=importlib.util.module_from_spec(s);s.loader.exec_module(runtime)
path=m.Path(${JSON.stringify(resolve("scripts/lib/gateway-boot-budget.json"))})
assert runtime.gateway_boot_budget()==json.loads(path.read_text())['seconds']
for invalid in (0,-1,True,None,'90',float('inf'),float('nan')):
 with unittest.mock.patch.object(runtime.Path,'read_text',return_value=json.dumps({'seconds':invalid})):
  try:runtime.gateway_boot_budget()
  except RuntimeError:pass
  else:raise AssertionError('invalid shared budget accepted')
import ast
calls=[node for node in ast.walk(ast.parse(m.Path(${JSON.stringify(runtime)}).read_text())) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='wait_for' and any(keyword.arg=='phase' and isinstance(keyword.value,ast.Constant) and keyword.value.value=='gateway-health' for keyword in node.keywords)]
assert len(calls)==1
assert any(keyword.arg=='seconds' and isinstance(keyword.value,ast.Call) and keyword.value.func.id=='gateway_boot_budget' for keyword in calls[0].keywords)
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("readiness reports owned exit and sanitized probe classification", () => {
    const runtime = resolve("scripts/install-e2e/macos-variants-runtime.py");
    const result = python(`
import sys,urllib.error
s=importlib.util.spec_from_file_location('runtime',${JSON.stringify(runtime)});runtime=importlib.util.module_from_spec(s);s.loader.exec_module(runtime)
child=runtime.subprocess.Popen([sys.executable,'-c','raise SystemExit(17)'],start_new_session=True);child.owned_role='gateway';child.wait(timeout=5)
try:runtime.wait_for(lambda:True,seconds=0,phase='gateway-health',children=[child])
except RuntimeError as error:assert str(error)=='isolated gateway-health: gateway exited before readiness, exit=17',str(error)
else:raise AssertionError('exited daemon accepted as ready')
def refused():raise urllib.error.HTTPError('https://example.invalid/private-secret',503,'Bearer private-secret',{},None)
try:runtime.wait_for(refused,seconds=0,phase='gateway-health')
except RuntimeError as error:assert str(error)=='isolated gateway-health did not become ready: HTTPError, status=503',str(error)
else:raise AssertionError('failed readiness passed')
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("TERM-shaped collector exit requires a new exact graceful marker in its owned log", () => {
    const runtime = resolve("scripts/install-e2e/macos-variants-runtime.py");
    const result = python(`
import sys,tempfile,time,os
s=importlib.util.spec_from_file_location('runtime',${JSON.stringify(runtime)});runtime=importlib.util.module_from_spec(s);s.loader.exec_module(runtime)
marker='2026-01-01T00:00:00.000Z INFO  [collector] Collector stopped\\n'
with tempfile.TemporaryDirectory() as temporary:
 directory=m.Path(temporary)
 for index,(code,after,before,expected) in enumerate([(143,True,False,True),(-15,True,False,True),(143,False,False,False),(143,False,True,False),(7,True,False,False)]):
  log=directory/('log-'+str(index));ready=directory/('ready-'+str(index));log.write_text(marker if before else '')
  action="os.kill(os.getpid(),signal.SIGTERM)" if code<0 else 'raise SystemExit('+str(code)+')'
  program="import os,signal,time;from pathlib import Path\\n"+"def stop(*_):\\n signal.signal(signal.SIGTERM,signal.SIG_DFL)\\n "+("Path("+repr(str(log))+").open('a').write("+repr(marker)+")\\n " if after else '')+action+"\\nsignal.signal(signal.SIGTERM,stop)\\nPath("+repr(str(ready))+").write_text('ready')\\nwhile True:time.sleep(.01)\\n"
  child=runtime.subprocess.Popen([sys.executable,'-c',program],start_new_session=True);child.owned_role='collector';child.owned_log=log
  observed=log.stat();child.owned_log_identity=(observed.st_dev,observed.st_ino)
  try:
   deadline=time.monotonic()+5
   while not ready.exists():
    assert child.poll() is None,'fixture exited before readiness'
    assert time.monotonic()<deadline,'fixture not ready'
    time.sleep(.01)
   try:runtime.retire_children([child],grace_seconds=1,force_seconds=1,require_success=True)
   except RuntimeError:assert not expected,'valid graceful marker refused'
   else:assert expected,'missing/new marker or unknown exit accepted'
   assert not runtime.group_running(child.pid)
  finally:runtime.retire_children([child],grace_seconds=.1,force_seconds=1)
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("TERM-shaped gateway exit requires fresh shutdown marker and removal of its observed owned lock", () => {
    const runtime = resolve("scripts/install-e2e/macos-variants-runtime.py");
    const result = python(`
import sys,tempfile,time
s=importlib.util.spec_from_file_location('runtime',${JSON.stringify(runtime)});runtime=importlib.util.module_from_spec(s);s.loader.exec_module(runtime)
marker='2026-01-01T00:00:00.000Z INFO  [gateway] Shutting down...\\n'
with tempfile.TemporaryDirectory() as temporary:
 directory=m.Path(temporary)
 for index,(code,after,before,initial,remove,expected) in enumerate([(143,True,False,True,True,True),(143,True,False,True,False,False),(143,False,True,True,True,False),(143,True,False,False,False,False),(7,True,False,True,True,False)]):
  log=directory/('log-'+str(index));ready=directory/('ready-'+str(index));lock=directory/('lock-'+str(index));log.write_text(marker if before else '')
  program="import os,signal,time,json;from pathlib import Path\\n"+"def stop(*_):\\n "+("Path("+repr(str(log))+").open('a').write("+repr(marker)+")\\n " if after else '')+("Path("+repr(str(lock))+").unlink()\\n " if remove else '')+"raise SystemExit("+str(code)+")\\n"+("Path("+repr(str(lock))+").write_text(json.dumps({'pid':os.getpid()}))\\n" if initial else '')+"signal.signal(signal.SIGTERM,stop)\\nPath("+repr(str(ready))+").write_text('ready')\\nwhile True:time.sleep(.01)\\n"
  child=runtime.subprocess.Popen([sys.executable,'-c',program],start_new_session=True);child.owned_role='gateway';child.owned_log=log;child.owned_lock=lock
  observed=log.stat();child.owned_log_identity=(observed.st_dev,observed.st_ino)
  try:
   deadline=time.monotonic()+5
   while not ready.exists():
    assert child.poll() is None,'fixture exited before readiness'
    assert time.monotonic()<deadline,'fixture not ready'
    time.sleep(.01)
   try:runtime.retire_children([child],grace_seconds=1,force_seconds=1,require_success=True)
   except RuntimeError:assert not expected,'complete gateway shutdown refused'
   else:assert expected,'incomplete/unobserved gateway shutdown accepted'
   assert not runtime.group_running(child.pid)
  finally:runtime.retire_children([child],grace_seconds=.1,force_seconds=1)
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("runtime retirement drains descendants and rejects forced or nonzero exits", () => {
    const runtime = resolve("scripts/install-e2e/macos-variants-runtime.py");
    const result = python(`
import sys,tempfile,time
s=importlib.util.spec_from_file_location('runtime',${JSON.stringify(runtime)});runtime=importlib.util.module_from_spec(s);s.loader.exec_module(runtime)
with tempfile.TemporaryDirectory() as temporary:
 ready=m.Path(temporary)/'ready'
 code="import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path("+repr(str(ready))+").write_text('ready');time.sleep(60)"
 leader="import subprocess,sys;subprocess.Popen([sys.executable,'-c',"+repr(code)+"])"
 child=runtime.subprocess.Popen([sys.executable,'-c',leader],start_new_session=True)
 try:
  while not ready.exists():time.sleep(.01)
  child.wait(timeout=5)
  try:runtime.retire_children([child],grace_seconds=.1,force_seconds=1,require_success=True)
  except RuntimeError as error:assert 'exit=0, forced=True' in str(error),str(error)
  else:raise AssertionError('forced descendant retirement passed')
  assert not runtime.group_running(child.pid)
 finally:runtime.retire_children([child],grace_seconds=.1,force_seconds=1)
 child=runtime.subprocess.Popen([sys.executable,'-c','raise SystemExit(7)'],start_new_session=True);child.wait(timeout=5)
 try:runtime.retire_children([child],require_success=True)
 except RuntimeError as error:assert 'exit=7, forced=False' in str(error),str(error)
 else:raise AssertionError('nonzero daemon passed')
`);
    expect(result.status, result.stderr).toBe(0);
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
