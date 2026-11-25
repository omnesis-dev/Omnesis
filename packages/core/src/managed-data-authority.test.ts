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
