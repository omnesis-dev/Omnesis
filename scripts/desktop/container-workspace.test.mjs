// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("container dependencies retain shared payloads but workspace imports resolve to the copied source", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-container-workspace-")));
  try {
    const root = join(scratch, "source"),
      dependencies = join(scratch, "dependencies");
    const workspace = join(root, "packages", "fixture");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(dependencies, "fixture-dependency"), { recursive: true });
    mkdirSync(join(dependencies, "@omnesis"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "@omnesis/fixture" }));
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./container-workspace.mjs", import.meta.url))],
      {
        cwd: root,
        env: {
          ...process.env,
          OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE: "fixture",
          OMNESIS_ACCOUNT_DEPENDENCIES: dependencies,
        },
      },
    );
    expect(readlinkSync(join(root, "node_modules", "fixture-dependency"))).toBe(
      join(dependencies, "fixture-dependency"),
    );
    expect(readlinkSync(join(root, "node_modules", "@omnesis", "fixture"))).toBe(workspace);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("each copied workspace retains its nested versions and resolves workspace imports locally", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-container-nested-resolution-")));
  try {
    const root = join(scratch, "source"),
      input = join(scratch, "input"),
      dependencies = join(scratch, "dependencies");
    const packageAt = (directory, name, version, body) => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name, version, type: "module", exports: "./index.mjs" }),
      );
      writeFileSync(join(directory, "index.mjs"), body);
    };
    const manifest = { workspaces: ["packages/*"] };
    const lock = {
      lockfileVersion: 3,
      packages: {
        "node_modules/fixture-versioned": { version: "1.0.0" },
        "node_modules/fixture-root-only": { version: "1.0.0" },
        "packages/consumer/node_modules/fixture-versioned": { version: "2.0.0" },
        "packages/consumer/node_modules/fixture-nested-sibling": { version: "1.0.0" },
      },
    };
    for (const directory of [root, input]) {
      mkdirSync(directory);
      writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
      writeFileSync(join(directory, "package-lock.json"), JSON.stringify(lock));
      for (const name of ["consumer", "fallback", "peer"])
        packageAt(
          join(directory, "packages", name),
          `@omnesis/${name}`,
          "1.0.0",
          `export const marker = ${JSON.stringify(directory === root ? "copied-workspace" : "donor-must-not-load")};`,
        );
    }
    packageAt(
      join(dependencies, "fixture-versioned"),
      "fixture-versioned",
      "1.0.0",
      "export const version = 'root-v1';",
    );
    packageAt(
      join(dependencies, "fixture-root-only"),
      "fixture-root-only",
      "1.0.0",
      "export const rootOnly = 'root-fallback';",
    );
    mkdirSync(join(dependencies, "@omnesis"));
    symlinkSync(join(input, "packages/peer"), join(dependencies, "@omnesis/peer"));
    symlinkSync(dependencies, join(input, "node_modules"));
    packageAt(
      join(input, "packages/consumer/node_modules/fixture-versioned"),
      "fixture-versioned",
      "2.0.0",
      "export const version = 'nested-v2'; export {sibling} from 'fixture-nested-sibling'; export {rootOnly} from 'fixture-root-only'; export {marker as workspaceMarker} from '@omnesis/peer'; export {linkedPeer} from './sibling-link.mjs';",
    );
    packageAt(
      join(input, "packages/consumer/node_modules/fixture-nested-sibling"),
      "fixture-nested-sibling",
      "1.0.0",
      "export const sibling = 'nested-sibling';",
    );
    writeFileSync(
      join(input, "packages/consumer/node_modules/fixture-nested-sibling/linked.mjs"),
      "export {marker as linkedPeer} from '@omnesis/peer';",
    );
    symlinkSync(
      join(input, "packages/consumer/node_modules/fixture-nested-sibling/linked.mjs"),
      join(input, "packages/consumer/node_modules/fixture-versioned/sibling-link.mjs"),
    );
    const donorBefore = readFileSync(
      join(input, "packages/consumer/node_modules/fixture-versioned/index.mjs"),
    );
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./container-workspace.mjs", import.meta.url))],
      {
        cwd: root,
        env: {
          ...process.env,
          OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE: "fixture",
          OMNESIS_ACCOUNT_DEPENDENCIES: dependencies,
          OMNESIS_ACCOUNT_INPUT_ROOT: input,
        },
      },
    );
    const observed = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {createRequire} from 'node:module';
          const output={};
          for(const name of ['consumer','fallback']) {
            const require=createRequire(new URL('./packages/'+name+'/package.json',import.meta.url));
            output[name]={...require('fixture-versioned'),peer:require('@omnesis/peer').marker};
          }
          process.stdout.write(JSON.stringify(output));`,
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
    expect(observed.consumer.version).toBe("nested-v2");
    expect(observed.consumer).toEqual({
      version: "nested-v2",
      sibling: "nested-sibling",
      rootOnly: "root-fallback",
      workspaceMarker: "copied-workspace",
      linkedPeer: "copied-workspace",
      peer: "copied-workspace",
    });
    expect(observed.fallback).toEqual({ version: "root-v1", peer: "copied-workspace" });
    expect(
      readFileSync(join(input, "packages/consumer/node_modules/fixture-versioned/index.mjs")),
    ).toEqual(donorBefore);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the account container mount preserves Node's sibling package resolution", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-container-module-resolution-")));
  try {
    const producer = readFileSync(new URL("./test-account-container.mjs", import.meta.url), "utf8");
    const mount = /const mountedDependencies = "([^"]+)";/.exec(producer)?.[1];
    expect(mount).toBeTruthy();
    const dependencies = join(scratch, mount.slice(1));
    const root = join(scratch, "source");
    mkdirSync(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
    for (const name of ["fixture-runner", "fixture-transformer"]) {
      const directory = join(dependencies, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name, type: "module", exports: "./index.mjs" }),
      );
      writeFileSync(
        join(directory, "index.mjs"),
        name === "fixture-runner"
          ? "export { marker } from 'fixture-transformer';"
          : "export const marker = 'owned-sibling-module';",
      );
    }
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./container-workspace.mjs", import.meta.url))],
      {
        cwd: root,
        env: {
          ...process.env,
          OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE: "fixture",
          OMNESIS_ACCOUNT_DEPENDENCIES: dependencies,
        },
      },
    );
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {marker} from 'fixture-runner'; process.stdout.write(marker);",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(output).toBe("owned-sibling-module");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("optional absence preserves local CLI and workspace aliases without changing the donor", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-container-local-cli-")));
  try {
    const root = join(scratch, "source"),
      input = join(scratch, "input"),
      dependencies = join(scratch, "dependencies");
    const manifest = { workspaces: ["packages/*"] };
    const lock = {
      packages: {
        "packages/cli/node_modules/fixture-optional": { version: "1.0.0", optional: true },
      },
    };
    for (const directory of [root, input]) {
      mkdirSync(join(directory, "packages/cli"), { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
      writeFileSync(join(directory, "package-lock.json"), JSON.stringify(lock));
      writeFileSync(
        join(directory, "packages/cli/package.json"),
        JSON.stringify({ name: "omnesis", bin: { omnesis: "bin.mjs" } }),
      );
      writeFileSync(
        join(directory, "packages/cli/bin.mjs"),
        `process.stdout.write(${JSON.stringify(directory === root ? "copied-cli" : "donor-must-not-run")});`,
      );
    }
    mkdirSync(join(dependencies, ".bin"), { recursive: true });
    symlinkSync(join(input, "packages/cli"), join(dependencies, "omnesis"), "dir");
    symlinkSync(join(input, "packages/cli/bin.mjs"), join(dependencies, ".bin/omnesis"));
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./container-workspace.mjs", import.meta.url))],
      {
        cwd: root,
        env: {
          ...process.env,
          OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE: "fixture",
          OMNESIS_ACCOUNT_DEPENDENCIES: dependencies,
          OMNESIS_ACCOUNT_INPUT_ROOT: input,
        },
      },
    );
    expect(realpathSync(join(root, "node_modules/omnesis"))).toBe(join(root, "packages/cli"));
    expect(realpathSync(join(root, "node_modules/.bin/omnesis"))).toBe(
      join(root, "packages/cli/bin.mjs"),
    );
    expect(
      execFileSync(process.execPath, [join(root, "node_modules/.bin/omnesis")], {
        encoding: "utf8",
      }),
    ).toBe("copied-cli");
    expect(readFileSync(join(input, "packages/cli/bin.mjs"), "utf8")).toContain(
      "donor-must-not-run",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("shared donor packages retain each caller's sibling versions across internal links", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-container-shared-donor-")));
  try {
    const root = join(scratch, "source"),
      input = join(scratch, "input"),
      dependencies = join(scratch, "dependencies");
    const manifest = { workspaces: ["packages/*"] },
      lock = { packages: {} };
    for (const name of ["first", "second"]) {
      lock.packages[`packages/${name}/node_modules/fixture-shared`] = { version: "1.0.0" };
      lock.packages[`packages/${name}/node_modules/fixture-sibling`] = {
        version: name === "first" ? "1.0.0" : "2.0.0",
      };
      for (const directory of [root, input]) {
        mkdirSync(join(directory, "packages", name), { recursive: true });
        writeFileSync(
          join(directory, "packages", name, "package.json"),
          JSON.stringify({ name: `@omnesis/${name}` }),
        );
      }
    }
    for (const directory of [root, input]) {
      writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
      writeFileSync(join(directory, "package-lock.json"), JSON.stringify(lock));
    }
    const shared = join(dependencies, "fixture-shared");
    mkdirSync(join(shared, "inner"), { recursive: true });
    writeFileSync(
      join(shared, "package.json"),
      JSON.stringify({
        name: "fixture-shared",
        version: "1.0.0",
        type: "module",
        exports: "./entry.mjs",
      }),
    );
    writeFileSync(join(shared, "inner/entry.mjs"), "export {marker} from 'fixture-sibling';");
    symlinkSync(join(shared, "inner/entry.mjs"), join(shared, "entry.mjs"));
    for (const name of ["first", "second"]) {
      const farm = join(input, "packages", name, "node_modules");
      mkdirSync(join(farm, "fixture-sibling"), { recursive: true });
      symlinkSync(shared, join(farm, "fixture-shared"), "dir");
      writeFileSync(
        join(farm, "fixture-sibling/package.json"),
        JSON.stringify({
          name: "fixture-sibling",
          version: name === "first" ? "1.0.0" : "2.0.0",
          type: "module",
          exports: "./index.mjs",
        }),
      );
      writeFileSync(
        join(farm, "fixture-sibling/index.mjs"),
        `export const marker = ${JSON.stringify(name)};`,
      );
    }
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./container-workspace.mjs", import.meta.url))],
      {
        cwd: root,
        env: {
          ...process.env,
          OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE: "fixture",
          OMNESIS_ACCOUNT_DEPENDENCIES: dependencies,
          OMNESIS_ACCOUNT_INPUT_ROOT: input,
        },
      },
    );
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import {createRequire} from 'node:module'; const result={};
      for(const name of ['first','second']) {
        const require=createRequire(new URL('./packages/'+name+'/package.json',import.meta.url));
        result[name]=require('fixture-shared').marker;
      }
      process.stdout.write(JSON.stringify(result));`,
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
    expect(result).toEqual({ first: "first", second: "second" });
    for (const name of ["first", "second"])
      expect(
        realpathSync(join(root, "packages", name, "node_modules/fixture-shared/entry.mjs")),
      ).toBe(join(root, "packages", name, "node_modules/fixture-shared/inner/entry.mjs"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "payload reader refuses a FIFO substituted immediately before open without blocking",
  () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-container-payload-race-")));
    try {
      const root = join(scratch, "source"),
        input = join(scratch, "input"),
        dependencies = join(scratch, "dependencies");
      const key = "packages/consumer/node_modules/fixture-payload";
      for (const directory of [root, input]) {
        mkdirSync(join(directory, "packages/consumer"), { recursive: true });
        writeFileSync(
          join(directory, "package.json"),
          JSON.stringify({ workspaces: ["packages/*"] }),
        );
        writeFileSync(
          join(directory, "package-lock.json"),
          JSON.stringify({ packages: { [key]: { version: "1.0.0" } } }),
        );
        writeFileSync(
          join(directory, "packages/consumer/package.json"),
          JSON.stringify({ name: "@omnesis/consumer" }),
        );
      }
      mkdirSync(dependencies);
      mkdirSync(join(input, key), { recursive: true });
      writeFileSync(
        join(input, key, "package.json"),
        JSON.stringify({ name: "fixture-payload", version: "1.0.0" }),
      );
      const payload = join(input, key, "entry.mjs"),
        receipt = join(scratch, "observed.json"),
        hook = join(scratch, "substitute.mjs");
      writeFileSync(payload, "export const marker='fixture';");
      writeFileSync(
        hook,
        `
      import fs from 'node:fs'; import {execFileSync} from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
      const original=fs.openSync; let swapped=false;
      fs.openSync=function(path,flags,...args) {
        if(path===${JSON.stringify(payload)}&&!swapped) {
          swapped=true; const nonBlocking=(flags&fs.constants.O_NONBLOCK)!==0;
          fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({nonBlocking}),{mode:0o600});
          if(!nonBlocking)throw new Error('Refusing to exercise a blocking FIFO open');
          fs.unlinkSync(path); execFileSync('mkfifo',[path]);
        }
        return original.call(this,path,flags,...args);
      };
      syncBuiltinESMExports();`,
      );
      expect(() =>
        execFileSync(
          process.execPath,
          ["--import", hook, fileURLToPath(new URL("./container-workspace.mjs", import.meta.url))],
          {
            cwd: root,
            env: {
              ...process.env,
              OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE: "fixture",
              OMNESIS_ACCOUNT_DEPENDENCIES: dependencies,
              OMNESIS_ACCOUNT_INPUT_ROOT: input,
            },
            stdio: "pipe",
          },
        ),
      ).toThrow("Nested container dependency changed");
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ nonBlocking: true });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test.each([
  ["lock-mismatch", "source and dependency lock differ"],
  ["workspace-mismatch", "Account container workspace manifest differs"],
  ["deeper-placement", "Unsupported nested container lock placement"],
  ["missing", "Required nested container dependency is missing"],
  ["dangling", "Nested container dependency is dangling"],
  ["escape", "Unsafe nested container dependency"],
  ["version", "Nested container dependency differs from lock"],
  ["payload-escape", "Nested container dependency escapes its payload"],
  ["cycle", "Cyclic nested container dependency"],
  ["oversize", "Unsafe or oversized nested container dependency"],
])(
  "nested container materialization refuses %s without altering the donor",
  (failure, expected) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-container-closure-refusal-")));
    try {
      const root = join(scratch, "source"),
        input = join(scratch, "input"),
        dependencies = join(scratch, "dependencies");
      const relativePackage = "packages/consumer/node_modules/fixture-versioned";
      const manifest = { workspaces: ["packages/*"] };
      const lock = { packages: { [relativePackage]: { version: "2.0.0" } } };
      for (const directory of [root, input]) {
        mkdirSync(join(directory, "packages/consumer"), { recursive: true });
        writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
        writeFileSync(join(directory, "package-lock.json"), JSON.stringify(lock));
        writeFileSync(
          join(directory, "packages/consumer/package.json"),
          JSON.stringify({ name: "@omnesis/consumer" }),
        );
      }
      mkdirSync(dependencies);
      const payload = join(input, relativePackage);
      mkdirSync(payload, { recursive: true });
      const metadata = JSON.stringify({ name: "fixture-versioned", version: "2.0.0" });
      writeFileSync(join(payload, "package.json"), metadata);
      const outside = join(scratch, "foreign-payload");
      mkdirSync(outside);
      writeFileSync(join(outside, "package.json"), metadata);
      writeFileSync(join(outside, "private-fixture"), "must-stay-outside");
      if (failure === "lock-mismatch") writeFileSync(join(input, "package-lock.json"), "{}");
      if (failure === "workspace-mismatch")
        writeFileSync(
          join(input, "packages/consumer/package.json"),
          JSON.stringify({ name: "@omnesis/other" }),
        );
      if (failure === "deeper-placement") {
        lock.packages[relativePackage + "/node_modules/fixture-child"] = { version: "1.0.0" };
        for (const directory of [root, input])
          writeFileSync(join(directory, "package-lock.json"), JSON.stringify(lock));
      }
      if (failure === "missing" || failure === "dangling" || failure === "escape") {
        rmSync(payload, { recursive: true });
        if (failure !== "missing")
          symlinkSync(failure === "escape" ? outside : join(input, "absent"), payload, "dir");
      }
      if (failure === "version")
        writeFileSync(
          join(payload, "package.json"),
          JSON.stringify({ name: "fixture-versioned", version: "3.0.0" }),
        );
      if (failure === "payload-escape")
        symlinkSync(join(outside, "private-fixture"), join(payload, "escape"));
      if (failure === "cycle") symlinkSync(payload, join(payload, "cycle"), "dir");
      if (failure === "oversize") {
        writeFileSync(join(payload, "large-fixture"), "");
        truncateSync(join(payload, "large-fixture"), 513 * 1024 * 1024);
      }
      expect(() =>
        execFileSync(
          process.execPath,
          [fileURLToPath(new URL("./container-workspace.mjs", import.meta.url))],
          {
            cwd: root,
            env: {
              ...process.env,
              OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE: "fixture",
              OMNESIS_ACCOUNT_DEPENDENCIES: dependencies,
              OMNESIS_ACCOUNT_INPUT_ROOT: input,
            },
            stdio: "pipe",
          },
        ),
      ).toThrow(expected);
      expect(readFileSync(join(outside, "private-fixture"), "utf8")).toBe("must-stay-outside");
      expect(readFileSync(join(root, "package-lock.json"), "utf8")).toBe(JSON.stringify(lock));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
