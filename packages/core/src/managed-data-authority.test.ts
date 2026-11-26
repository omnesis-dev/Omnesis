// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-data-authority-")));
  roots.push(root);
  const configDir = join(root, "library");
  mkdirSync(`${configDir}.bootstrap`, { mode: 0o700 });
  const service = `dev.omnesis.desktop.${"a".repeat(64)}`;
  const fd = openSync(
    join(`${configDir}.bootstrap`, `.data-use-${"a".repeat(64)}.lock`),
    "wx+",
    0o600,
  );
  const metadata = fstatSync(fd, { bigint: true });
  return {
    root,
    fd,
    scope: { format: 1, configDir, instance: `desktop-${"a".repeat(16)}`, secretService: service },
    lease: { device: metadata.dev.toString(), inode: metadata.ino.toString() },
  };
}
function run(source: string, fd?: number) {
  const module = new URL("./node-command.ts", import.meta.url).href;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const node=await import(${JSON.stringify(module)});${source}`],
    {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", fd ?? "ignore"],
    },
  );
}
test("bare Node source controller emits only the fixed operation invocation and no secret arguments", () => {
  const f = fixture();
  try {
    const result = run(`
      node.installManagedRuntimeLauncher({root:${JSON.stringify(f.root)},launcher:${JSON.stringify(join(f.root, "runtime-exec"))},preload:${JSON.stringify(join(f.root, "packages/core/dist/managed-runtime-bootstrap.js"))}});
      const result=node.managedDesktopDataOperationInvocation(${JSON.stringify(f.scope)},'erase','00000000-0000-4000-8000-000000000001');
      process.stdout.write(JSON.stringify(result));
    `);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.command).toBe(join(f.root, "runtime-exec"));
    expect(output.args.slice(0, 3)).toEqual([
      "--data-exclusive",
      "erase",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(JSON.parse(Buffer.from(output.args[3], "base64url").toString())).toEqual(f.scope);
  } finally {
    closeSync(f.fd);
  }
});
test("operation context preserves FD7 through owned stdio and argv, and refuses a closed authority", () => {
  const f = fixture();
  const operationId = "00000000-0000-4000-8000-000000000001";
  try {
    const result = run(
      `
      const {closeSync}=await import('node:fs');
      node.installManagedRuntimeLauncher({root:${JSON.stringify(f.root)},launcher:${JSON.stringify(join(f.root, "runtime-exec"))},preload:${JSON.stringify(join(f.root, "packages/core/dist/managed-runtime-bootstrap.js"))},
        data:${JSON.stringify({ format: 1, scope: f.scope, lease: f.lease, exclusive: { purpose: "erase", operationId } })}});
      node.assertManagedDesktopDataAuthority(${JSON.stringify(f.scope)},'erase',${JSON.stringify(operationId)});
      const stdio=node.managedRuntimeSubprocessStdio(['pipe','pipe','pipe','ipc']);
      const invocation=node.managedNodeInvocation(['worker.js']);
      const external=node.managedRuntimeExecutableInvocation('python',['fixture.py']);
      const preload=node.managedRuntimePreload();
      closeSync(7);let refused=false;try{node.assertManagedDesktopDataAuthority(${JSON.stringify(f.scope)},'erase',${JSON.stringify(operationId)})}catch{refused=true}
      process.stdout.write(JSON.stringify({stdio,invocation,external,preload,refused}));
    `,
      f.fd,
    );
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.stdio).toEqual(["pipe", "pipe", "pipe", "ipc", "ignore", "ignore", "ignore", 7]);
    expect(output.invocation.args.slice(0, 3)).toEqual(["--data-inherit", "erase", operationId]);
    expect(output.external.args.slice(-3)).toEqual(["--external", "python", "fixture.py"]);
    const data = new URL(output.preload[2]).searchParams.get("data");
    expect(JSON.parse(Buffer.from(data!, "base64url").toString()).exclusive).toEqual({
      purpose: "erase",
      operationId,
    });
    expect(output.refused).toBe(true);
  } finally {
    closeSync(f.fd);
  }
});
test("metadata without the native inherited descriptor is never authority", () => {
  const f = fixture();
  try {
    const result = run(
      `let refused=false;try{node.installManagedRuntimeLauncher({root:${JSON.stringify(f.root)},launcher:${JSON.stringify(join(f.root, "runtime-exec"))},preload:${JSON.stringify(join(f.root, "packages/core/dist/managed-runtime-bootstrap.js"))},data:${JSON.stringify({ format: 1, scope: f.scope, lease: f.lease, exclusive: { purpose: "erase", operationId: "00000000-0000-4000-8000-000000000001" } })}})}catch{refused=true}process.stdout.write(JSON.stringify({refused}));`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).refused).toBe(true);
  } finally {
    closeSync(f.fd);
  }
});

test("catalog discovery requires native data-consumer authority and keeps its fixed prefix through wrapping", () => {
  const f = fixture();
  try {
    const refused = run(`
      try { node.managedDesktopCatalogDiscoveryInvocation('/example/sdk',['app-server'],'00000000-0000-4000-8000-000000000001'); process.exit(2); }
      catch(error) { process.stdout.write(error.message); }
    `);
    expect(refused.status).toBe(0);
    expect(refused.stdout).toContain("installed data-consumer runtime");
    const launcher = join(f.root, "runtime-exec");
    const result = run(
      `
      node.installManagedRuntimeLauncher({root:${JSON.stringify(f.root)},launcher:${JSON.stringify(launcher)},preload:${JSON.stringify(join(f.root, "packages/core/dist/managed-runtime-bootstrap.js"))},data:${JSON.stringify({ format: 1, scope: f.scope, lease: f.lease })}});
      const invocation=node.managedDesktopCatalogDiscoveryInvocation('/example/sdk',['app-server'],'00000000-0000-4000-8000-000000000001');
      process.stdout.write(JSON.stringify(node.nodeCommandInvocation(invocation.command,invocation.args)));
    `,
      f.fd,
    );
    expect(result.status, result.stderr).toBe(0);
    const invocation = JSON.parse(result.stdout);
    expect(invocation.command).toBe(launcher);
    expect(invocation.args.slice(0, 3)).toEqual([
      "--catalog-discovery",
      "00000000-0000-4000-8000-000000000001",
      "--data-use",
    ]);
    expect(invocation.args.slice(-3)).toEqual(["--external", "/example/sdk", "app-server"]);
  } finally {
    closeSync(f.fd);
  }
});

test("Node execve keeps PID identity but a native handoff must reacquire inherited data authority", () => {
  const f = fixture();
  try {
    const probe = `import {fstatSync} from 'node:fs';let retained=false;try{const info=fstatSync(7,{bigint:true});retained=info.dev.toString()===${JSON.stringify(f.lease.device)}&&info.ino.toString()===${JSON.stringify(f.lease.inode)}}catch{}process.stdout.write(JSON.stringify({retained,pid:process.pid}));`;
    const result = run(
      `const pid=process.pid;const next=${JSON.stringify(probe)}+"if(process.pid!=="+pid+")process.exit(2);";process.execve(process.execPath,[process.execPath,'--input-type=module','-e',next],process.env);`,
      f.fd,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).retained).toBe(false);
  } finally {
    closeSync(f.fd);
  }
});

test("the scoped process certificate cannot authorize a caller's different managed profile", () => {
  const f = fixture();
  try {
    writeFileSync(
      join(`${f.scope.configDir}.bootstrap`, "process-authority.json"),
      JSON.stringify({
        version: 3,
        owner: "omnesis-desktop",
        instance: f.scope.instance,
        secretService: f.scope.secretService,
      }),
      { mode: 0o600 },
    );
    const result = run(
      `
      node.installManagedRuntimeLauncher({root:${JSON.stringify(f.root)},launcher:${JSON.stringify(join(f.root, "runtime-exec"))},preload:${JSON.stringify(join(f.root, "packages/core/dist/managed-runtime-bootstrap.js"))},data:{format:1,scope:${JSON.stringify(f.scope)},lease:${JSON.stringify(f.lease)}}});
      node.assertManagedDesktopProcessAuthority(${JSON.stringify(f.scope)});
      let refused=false;try{node.assertManagedDesktopProcessAuthority({...${JSON.stringify(f.scope)},configDir:${JSON.stringify(join(f.root, "another-library"))}})}catch{refused=true}
      if(!refused)throw new Error('A foreign profile inherited process authority');process.stdout.write('bound');
    `,
      f.fd,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("bound");
  } finally {
    closeSync(f.fd);
  }
});

test("key recovery factory is control-only and never accepts inherited shared or exclusive DATA", () => {
  const f = fixture();
  const context = {
    version: 1,
    scope: f.scope,
    root: { device: "1", inode: "2" },
    update: null,
    restore: null,
  };
  try {
    for (const data of [
      undefined,
      { format: 1, scope: f.scope, lease: f.lease },
      {
        format: 1,
        scope: f.scope,
        lease: f.lease,
        exclusive: { purpose: "erase", operationId: "00000000-0000-4000-8000-000000000001" },
      },
    ]) {
      const result = run(
        `
        node.installManagedRuntimeLauncher({root:${JSON.stringify(f.root)},launcher:${JSON.stringify(join(f.root, "runtime-exec"))},preload:${JSON.stringify(join(f.root, "packages/core/dist/managed-runtime-bootstrap.js"))},data:${JSON.stringify(data)}});
        let refused=false;try{const invocation=node.managedDesktopKeyRecoveryInvocation(${JSON.stringify(context)});process.stdout.write(invocation.args[0])}catch{refused=true}
        if(refused!==${data !== undefined})throw new Error('Key recovery DATA boundary was not enforced');
      `,
        f.fd,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(data ? "" : "--key-recovery");
    }
  } finally {
    closeSync(f.fd);
  }
});
