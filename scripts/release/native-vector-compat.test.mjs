// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { expect, test } from "vitest";
import {
  ensureNativeVectorCompatibility,
  resolveUsearch,
  runOwned,
} from "../native-vector-compat.mjs";

const ok = { code: 0, signal: null, timedOut: false, interrupted: false };
const bad = { ...ok, code: null, signal: "SIGSEGV" };
const located = {
  gateway: "/fixture/gateway with spaces",
  entry: "/fixture/project/node_modules/usearch/entry.js",
  root: "/fixture/project/node_modules/usearch",
};
function fixtureRunner(outcomes) {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    const outcome = outcomes.shift();
    if (!outcome) throw Error("unexpected subprocess");
    return outcome;
  };
  return { calls, run };
}
function options(run) {
  return {
    packageDir: located.gateway,
    platform: "darwin",
    arch: "x64",
    locate: () => located,
    run,
    env: {
      PATH: "/fixture/bin",
      OPENAI_API_KEY: "SECRET-CANARY",
      NODE_OPTIONS: "--require /secret",
    },
  };
}

// Model an installed registry dependency, including the lockfile identity npm12
// requires for exact-version script approvals. No fixture performs a fetch.
function installedRegistryFixture(prefix, target) {
  const project = existsSync(join(prefix, "package.json"))
    ? JSON.parse(readFileSync(join(prefix, "package.json"), "utf8"))
    : {};
  writeFileSync(
    join(prefix, "package-lock.json"),
    JSON.stringify({
      name: "fixture-root",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": project,
        [relative(prefix, target)]: {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/usearch/-/usearch-1.0.0.tgz",
          hasInstallScript: true,
        },
      },
    }),
  );
}

test.each([
  ["linux", "x64"],
  ["darwin", "arm64"],
  ["win32", "x64"],
])("%s/%s is an early no-mutation no-subprocess return", async (platform, arch) => {
  expect(
    await ensureNativeVectorCompatibility({
      platform,
      arch,
      locate: () => {
        throw Error("lookup");
      },
      run: () => {
        throw Error("spawn");
      },
    }),
  ).toEqual({ repaired: false, applicable: false });
});

test("working native vectors are idempotent and do not require toolchain or rebuild", async () => {
  const runner = fixtureRunner([ok, ok]);
  await expect(ensureNativeVectorCompatibility(options(runner.run))).resolves.toEqual({
    repaired: false,
    applicable: true,
  });
  await expect(ensureNativeVectorCompatibility(options(runner.run))).resolves.toEqual({
    repaired: false,
    applicable: true,
  });
  expect(runner.calls).toHaveLength(2);
  for (const [command, args, setup] of runner.calls) {
    expect(command).toBe(process.execPath);
    expect(args.slice(-3)).toEqual([located.entry, located.root, "any"]);
    expect(args[2]).toContain("restored.load('probe.usearch')");
    expect(args[2]).toContain("index.add([1n,2n,3n],vectors,1)");
    expect(setup.timeoutMs).toBe(20000);
    expect(JSON.stringify(setup.env)).not.toContain("SECRET-CANARY");
    expect(setup.env.NODE_OPTIONS).toBe("--max-old-space-size=512");
    expect(existsSync(setup.cwd)).toBe(false);
  }
});

test("failed actual vector probe repairs only usearch once and verifies the compiled binding", async () => {
  const runner = fixtureRunner([bad, ok, ok, ok]);
  expect(await ensureNativeVectorCompatibility(options(runner.run))).toEqual({
    repaired: true,
    applicable: true,
  });
  expect(runner.calls.map(([command]) => command)).toEqual([
    process.execPath,
    "xcode-select",
    "npm",
    process.execPath,
  ]);
  const [, args, setup] = runner.calls[2];
  expect(args).toEqual([
    "rebuild",
    located.root,
    "--prefix",
    "/fixture/project",
    "--workspaces=false",
  ]);
  expect(setup.cwd).toBe("/fixture/project");
  expect(setup.timeoutMs).toBe(600000);
  expect(setup.env).toMatchObject({
    npm_config_build_from_source: "true",
    npm_config_jobs: "2",
    MAKEFLAGS: "-j2",
  });
  expect(runner.calls[3][1].at(-1)).toBe("built");
  expect(runner.calls[3][1][2]).toContain("/build/Release/");
});

test.each([
  [[bad, bad], /requires Xcode/],
  [[bad, ok, { ...ok, code: 1 }], /Could not compile/],
  [[bad, ok, { ...ok, timedOut: true }], /Could not compile/],
  [[bad, ok, ok, bad], /failed its compatibility check/],
  [[{ ...bad, interrupted: true }], /interrupted/],
])(
  "failed prerequisites/build/recheck fail closed and always remove private scratch",
  async (outcomes, error) => {
    const runner = fixtureRunner([...outcomes]);
    await expect(ensureNativeVectorCompatibility(options(runner.run))).rejects.toThrow(error);
    expect(existsSync(runner.calls[0][2].cwd)).toBe(false);
    expect(runner.calls).toHaveLength(outcomes.length);
  },
);

test("resolves the exact gateway dependency with spaces without assuming exported package.json", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "vector package spaces ' ")));
  try {
    const gateway = join(scratch, "gateway"),
      dependency = join(gateway, "node_modules/usearch");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(gateway, "package.json"), JSON.stringify({ name: "@omnesis/gateway" }));
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({ name: "usearch", exports: "./entry.js" }),
    );
    writeFileSync(join(dependency, "entry.js"), "");
    expect(resolveUsearch(gateway)).toEqual({
      gateway,
      root: dependency,
      entry: join(dependency, "entry.js"),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("owned subprocess timeout and secret output remain fixed numeric status", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "vector-process-")));
  try {
    const failure = await runOwned(
      process.execPath,
      ["-e", "console.error('SECRET-CANARY');process.exit(7)"],
      { cwd: scratch, env: {}, timeoutMs: 1000 },
    );
    expect(failure).toEqual({ code: 7, signal: null, timedOut: false, interrupted: false });
    const timeout = await runOwned(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { cwd: scratch, env: {}, timeoutMs: 250 },
    );
    expect(timeout.timedOut).toBe(true);
    expect(timeout.signal).toBe("SIGKILL");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("owns and drains a surviving grandchild after a successful leader exits", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "vector-grandchild-")));
  try {
    const pidfile = join(scratch, "pid");
    const program =
      "const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1],String(child.pid));child.unref();";
    expect(
      (
        await runOwned(process.execPath, ["-e", program, pidfile], {
          cwd: scratch,
          env: {},
          timeoutMs: 2000,
        })
      ).code,
    ).toBe(0);
    const pid = Number(readFileSync(pidfile, "utf8"));
    const state = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
    }).stdout.trim();
    expect(!state || state.startsWith("Z")).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("root and published gateway share the standalone helper after patch-package", () => {
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  expect(manifest.scripts.postinstall).toBe(
    "patch-package && node scripts/native-vector-compat.mjs --package-dir packages/gateway && " +
      "node scripts/duckdb-extensions.mjs --package-dir packages/gateway --best-effort",
  );
});

test("cancellation promptly drains TERM-resistant leader and grandchild without waiting for build timeout", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "vector-cancel-")));
  try {
    const helper = new URL("../native-vector-compat.mjs", import.meta.url).href;
    const program = `import {runOwned} from ${JSON.stringify(helper)};import {existsSync,readFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
const started=Date.now();const ready=process.argv[1];
const command="const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',\\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\\"],{stdio:'ignore'});writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);";
const task=runOwned(process.execPath,['-e',command,ready],{cwd:process.cwd(),env:{},timeoutMs:600000});
for(let i=0;i<100&&!existsSync(ready);i++)await delay(10);
const wasReady=existsSync(ready);process.kill(process.pid,'SIGTERM');
const result=await task;if(!wasReady)throw Error('child not ready');console.log(JSON.stringify({result,pid:Number(readFileSync(ready,'utf8')),elapsed:Date.now()-started}));`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", program, join(scratch, "ready")],
      { cwd: scratch, encoding: "utf8", timeout: 15000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.result.interrupted).toBe(true);
    expect(data.result.timedOut).toBe(false);
    expect(data.elapsed).toBeLessThan(5000);
    const state = spawnSync("ps", ["-p", String(data.pid), "-o", "stat="], {
      encoding: "utf8",
    }).stdout.trim();
    expect(!state || state.startsWith("Z")).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("cleanup failure preserves the original numeric failure and fails closed", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "vector-cleanup-error-")));
  try {
    const error = await runOwned(process.execPath, ["-e", "process.exit(7)"], {
      cwd: scratch,
      env: {},
      timeoutMs: 1000,
      retire: () => {
        throw Error("cleanup control");
      },
    }).catch((failure) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.ownedCleanupFailed).toBe(true);
    expect(error.errors[0].cause.code).toBe(7);
    expect(error.cause.message).toBe("cleanup control");
    expect(error.errors[1].message).toBe("cleanup control");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "actual installed native vectors succeed without touching dependency files or invoking npm",
  async () => {
    const result = await ensureNativeVectorCompatibility({
      packageDir: resolve("packages/gateway"),
      platform: "darwin",
      arch: "x64",
      run: (command, args, setup) => {
        expect(command).toBe(process.execPath);
        return runOwned(command, args, setup);
      },
    });
    expect(result).toEqual({ repaired: false, applicable: true });
  },
);

test.each(["published-hoisted", "published-nested", "source-workspace", "global-nested"])(
  "real npm rebuild targets only resolved usearch in %s with special path characters",
  async (layout) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "native npm scope ' spaces ")));
    try {
      function pkg(directory, name, extras = {}) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "package.json"),
          JSON.stringify({
            name,
            version: "1.0.0",
            scripts: { install: "node install.cjs" },
            ...extras,
          }),
        );
        writeFileSync(
          join(directory, "install.cjs"),
          "require('node:fs').writeFileSync(require('node:path').join(__dirname,'rebuilt'),'yes')",
        );
      }
      const global = layout === "global-nested";
      const prefix = global ? join(scratch, "lib") : scratch;
      const app = global ? join(prefix, "node_modules/omnesis") : scratch;
      const gateway =
        layout === "source-workspace"
          ? join(scratch, "packages/gateway")
          : join(app, "node_modules/@omnesis/gateway");
      const home = join(scratch, "user-home");
      mkdirSync(home);
      if (global) {
        pkg(app, "omnesis");
        writeFileSync(join(home, ".npmrc"), "allow-scripts=usearch@1.0.0\n");
      } else {
        pkg(scratch, "fixture-root", {
          allowScripts: { "usearch@1.0.0": true },
          ...(layout === "source-workspace" ? { private: true, workspaces: ["packages/*"] } : {}),
        });
      }
      pkg(gateway, "@omnesis/gateway", { dependencies: { usearch: "1.0.0" } });
      const target =
        layout === "published-nested"
          ? join(gateway, "node_modules/usearch")
          : join(app, "node_modules/usearch");
      pkg(target, "usearch");
      const unrelated = join(target, "node_modules/unrelated");
      pkg(unrelated, "unrelated");
      const otherWorkspace = join(scratch, "packages/unrelated");
      pkg(otherWorkspace, "unrelated-workspace");
      installedRegistryFixture(prefix, target);
      const policyPath = global ? join(home, ".npmrc") : join(scratch, "package.json");
      const policyBefore = readFileSync(policyPath, "utf8");
      let probes = 0;
      const calls = [];
      const result = await ensureNativeVectorCompatibility({
        packageDir: gateway,
        platform: "darwin",
        arch: "x64",
        env: { PATH: process.env.PATH, HOME: home },
        locate: () => ({ gateway, root: target, entry: join(target, "entry.js") }),
        run: async (command, args, setup) => {
          calls.push([command, args]);
          if (command === process.execPath) return probes++ === 0 ? bad : ok;
          if (command === "xcode-select") return ok;
          return runOwned(command, args, setup);
        },
      });
      expect(result.repaired).toBe(true);
      expect(readFileSync(policyPath, "utf8")).toBe(policyBefore);
      expect(readFileSync(join(target, "rebuilt"), "utf8")).toBe("yes");
      for (const directory of [scratch, app, gateway, unrelated, otherWorkspace])
        expect(existsSync(join(directory, "rebuilt"))).toBe(false);
      expect(calls.filter(([command]) => command === "npm")).toHaveLength(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test("only compilation inherits the header-cache HOME and explicit network/toolchain settings", async () => {
  const runner = fixtureRunner([bad, ok, ok, ok]);
  await ensureNativeVectorCompatibility({
    ...options(runner.run),
    env: {
      PATH: process.env.PATH,
      HOME: "/fixture/cache-home",
      NODE_EXTRA_CA_CERTS: "/fixture/trust.pem",
      HTTPS_PROXY: "https://proxy.example.org",
      npm_config_devdir: "/fixture/node-headers",
      SDKROOT: "/fixture/sdk",
      npm_config_ignore_scripts: "true",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_allow_scripts: "usearch",
      NPM_CONFIG_ALLOW_SCRIPTS: "usearch",
      npm_config_userconfig: "/fixture/user.npmrc",
      npm_config_globalconfig: "/fixture/global.npmrc",
      NPM_CONFIG_USERCONFIG: "/fixture/upper-user.npmrc",
      NPM_CONFIG_GLOBALCONFIG: "/fixture/upper-global.npmrc",
      OPENAI_API_KEY: "MODEL-SECRET-CANARY",
      NODE_OPTIONS: "--require /private-preload",
      NODE_PATH: "/private-modules",
    },
  });
  const build = runner.calls[2][2].env;
  expect(build).toMatchObject({
    HOME: "/fixture/cache-home",
    NODE_EXTRA_CA_CERTS: "/fixture/trust.pem",
    HTTPS_PROXY: "https://proxy.example.org",
    npm_config_devdir: "/fixture/node-headers",
    SDKROOT: "/fixture/sdk",
    npm_config_ignore_scripts: "true",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    npm_config_allow_scripts: "usearch",
    NPM_CONFIG_ALLOW_SCRIPTS: "usearch",
    npm_config_userconfig: "/fixture/user.npmrc",
    npm_config_globalconfig: "/fixture/global.npmrc",
    NPM_CONFIG_USERCONFIG: "/fixture/upper-user.npmrc",
    NPM_CONFIG_GLOBALCONFIG: "/fixture/upper-global.npmrc",
  });
  expect(JSON.stringify(build)).not.toContain("MODEL-SECRET-CANARY");
  expect(build.NODE_OPTIONS).toBe("--max-old-space-size=512");
  expect(build.NODE_PATH).toBeUndefined();
  for (const index of [0, 1, 3]) {
    const probe = runner.calls[index][2].env;
    expect(probe.HOME).not.toBe(build.HOME);
    for (const key of [
      "NODE_EXTRA_CA_CERTS",
      "HTTPS_PROXY",
      "npm_config_devdir",
      "npm_config_ignore_scripts",
      "NPM_CONFIG_IGNORE_SCRIPTS",
      "npm_config_allow_scripts",
      "NPM_CONFIG_ALLOW_SCRIPTS",
      "npm_config_userconfig",
      "npm_config_globalconfig",
      "NPM_CONFIG_USERCONFIG",
      "NPM_CONFIG_GLOBALCONFIG",
      "SDKROOT",
      "OPENAI_API_KEY",
      "NODE_PATH",
    ])
      expect(probe[key]).toBeUndefined();
  }
});

test.each([
  ["project denial", false, {}],
  ["environment ignore", true, { npm_config_ignore_scripts: "true" }],
  ["uppercase environment ignore", true, { NPM_CONFIG_IGNORE_SCRIPTS: "true" }],
])(
  "explicit %s is preserved and cannot yield a repaired result",
  async (_label, approved, policyEnv) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "native-npm-denied-")));
    try {
      const target = join(scratch, "node_modules/usearch");
      const gateway = join(scratch, "node_modules/@omnesis/gateway");
      const binder = join(target, "node_modules/node-gyp-build");
      mkdirSync(binder, { recursive: true });
      mkdirSync(gateway, { recursive: true });
      const policy = JSON.stringify({
        name: "fixture-user-project",
        version: "1.0.0",
        dependencies: { usearch: "1.0.0" },
        allowScripts: { "usearch@1.0.0": approved },
      });
      writeFileSync(join(scratch, "package.json"), policy);
      writeFileSync(
        join(target, "package.json"),
        JSON.stringify({
          name: "usearch",
          version: "1.0.0",
          scripts: { install: "node install.cjs" },
        }),
      );
      writeFileSync(join(target, "entry.js"), "");
      writeFileSync(
        join(target, "install.cjs"),
        "require('node:fs').writeFileSync('rebuilt','yes')",
      );
      writeFileSync(
        join(binder, "index.js"),
        `module.exports=()=>{throw Error('binding must not load')};module.exports.path=()=>${JSON.stringify(join(target, "prebuilds/darwin-x64/node.napi.node"))};`,
      );
      installedRegistryFixture(scratch, target);
      let probes = 0;
      let builds = 0;
      await expect(
        ensureNativeVectorCompatibility({
          packageDir: gateway,
          platform: "darwin",
          arch: "x64",
          env: { PATH: process.env.PATH, ...policyEnv },
          locate: () => ({ gateway, root: target, entry: join(target, "entry.js") }),
          run: (command, args, setup) => {
            if (command === process.execPath && probes++ === 0) return Promise.resolve(bad);
            if (command === "xcode-select") return Promise.resolve(ok);
            if (command === "npm") builds++;
            return runOwned(command, args, setup);
          },
        }),
      ).rejects.toThrow(/Approve the usearch native build in your existing npm script policy/);
      expect(builds).toBe(1);
      expect(existsSync(join(target, "rebuilt"))).toBe(false);
      expect(readFileSync(join(scratch, "package.json"), "utf8")).toBe(policy);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test("refuses compilation outside a normal npm dependency tree", async () => {
  const runner = fixtureRunner([bad, ok]);
  await expect(
    ensureNativeVectorCompatibility({
      ...options(runner.run),
      locate: () => ({ ...located, root: "/fixture/external-store/usearch" }),
    }),
  ).rejects.toThrow(/outside an npm installation tree/);
  expect(runner.calls.map(([command]) => command)).toEqual([process.execPath, "xcode-select"]);
});

test.each(["relative/npm-cli.js", "/nonexistent-native-vector-fixture/npm-cli.js"])(
  "invalid invoking npm path %s never falls back to another npm",
  async (npm_execpath) => {
    const runner = fixtureRunner([bad, ok]);
    await expect(
      ensureNativeVectorCompatibility({
        ...options(runner.run),
        env: { PATH: process.env.PATH, npm_execpath },
      }),
    ).rejects.toThrow(/existing absolute npm_execpath/);
    expect(runner.calls).toHaveLength(2);
  },
);

test.each(
  [
    [
      "project",
      join(dirname(createRequire(import.meta.url).resolve("npm/package.json")), "bin/npm-cli.js"),
    ],
    ["invoking", process.env.npm_execpath],
  ].filter(([, cli]) => cli),
)(
  "%s lifecycle npm wins over a competing PATH npm and runs only the selected dependency",
  async (_label, actualNpm) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "native-invoking-npm-")));
    try {
      const target = join(scratch, "node_modules/usearch"),
        gateway = join(scratch, "packages/gateway");
      const bin = join(scratch, "bin");
      for (const path of [target, gateway, bin]) mkdirSync(path, { recursive: true });
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({
          name: "fixture-root",
          version: "1.0.0",
          dependencies: { usearch: "1.0.0" },
          allowScripts: { "usearch@1.0.0": true },
        }),
      );
      writeFileSync(
        join(target, "package.json"),
        JSON.stringify({
          name: "usearch",
          version: "1.0.0",
          scripts: { install: "node install.cjs" },
        }),
      );
      writeFileSync(
        join(target, "install.cjs"),
        "require('node:fs').writeFileSync('rebuilt','yes')",
      );
      const unrelated = join(target, "node_modules/unrelated");
      mkdirSync(unrelated, { recursive: true });
      writeFileSync(
        join(unrelated, "package.json"),
        JSON.stringify({
          name: "unrelated",
          version: "1.0.0",
          scripts: { install: "node install.cjs" },
        }),
      );
      writeFileSync(
        join(unrelated, "install.cjs"),
        "require('node:fs').writeFileSync('rebuilt','unexpected')",
      );
      const trapMarker = join(scratch, "wrong-npm"),
        invokedMarker = join(scratch, "invoked.json");
      writeFileSync(
        join(bin, "npm"),
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(trapMarker)},'wrong');process.exit(77);\n`,
      );
      chmodSync(join(bin, "npm"), 0o755);
      const invoker = join(scratch, "selected-npm-cli.cjs");
      writeFileSync(
        invoker,
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(invokedMarker)},JSON.stringify({args:process.argv.slice(2),model:process.env.OPENAI_API_KEY??null,nodePath:process.env.NODE_PATH??null,nodeOptions:process.env.NODE_OPTIONS}));require('node:child_process').execFileSync(process.execPath,[${JSON.stringify(actualNpm)},...process.argv.slice(2)],{stdio:'ignore',env:process.env});`,
      );
      installedRegistryFixture(scratch, target);
      let probes = 0;
      const result = await ensureNativeVectorCompatibility({
        packageDir: gateway,
        platform: "darwin",
        arch: "x64",
        env: {
          PATH: bin + ":" + process.env.PATH,
          npm_execpath: invoker,
          OPENAI_API_KEY: "MODEL-CANARY",
          NODE_PATH: "/fixture/private-modules",
          NODE_OPTIONS: "--require /fixture/private-preload",
        },
        locate: () => ({ gateway, root: target, entry: join(target, "entry.js") }),
        run: (command, args, setup) => {
          if (command === process.execPath && args[0] !== invoker)
            return Promise.resolve(probes++ === 0 ? bad : ok);
          if (command === "xcode-select") return Promise.resolve(ok);
          return runOwned(command, args, setup);
        },
      });
      expect(result.repaired).toBe(true);
      expect(existsSync(trapMarker)).toBe(false);
      expect(existsSync(join(unrelated, "rebuilt"))).toBe(false);
      expect(readFileSync(join(target, "rebuilt"), "utf8")).toBe("yes");
      expect(JSON.parse(readFileSync(invokedMarker, "utf8"))).toEqual({
        args: ["rebuild", target, "--prefix", scratch, "--workspaces=false"],
        model: null,
        nodePath: null,
        nodeOptions: "--max-old-space-size=512",
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
