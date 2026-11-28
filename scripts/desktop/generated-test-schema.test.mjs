// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const helper = fileURLToPath(
  new URL("../../macos/Tests/Support/capture-generated-test-schema.py", import.meta.url),
);
const posix = test.skipIf(process.platform === "win32");
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-test-schema-")));
  roots.push(root);
  const products = join(root, "products"),
    evidence = join(root, "evidence");
  mkdirSync(products, { mode: 0o700 });
  function plist(value, binary = false, name = "fixture.xctestrun") {
    const result = spawnSync(
      "python3",
      [
        "-c",
        "import json,plistlib,sys;sys.stdout.buffer.write(plistlib.dumps(json.load(sys.stdin),fmt=plistlib.FMT_BINARY if sys.argv[1]=='binary' else plistlib.FMT_XML))",
        binary ? "binary" : "xml",
      ],
      { input: JSON.stringify(value) },
    );
    expect(result.status).toBe(0);
    writeFileSync(join(products, name), result.stdout, { mode: 0o600 });
    return result.stdout;
  }
  function run() {
    const result = spawnSync("python3", [helper, "--products", products, "--evidence", evidence], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const leaves = readdirSync(evidence);
    expect(leaves).toHaveLength(1);
    const leaf = join(evidence, leaves[0]),
      path = join(leaf, "latest.txt");
    expect(statSync(leaf).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = readFileSync(path, "utf8");
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(65536);
    expect(raw).not.toContain(root);
    return { value: JSON.parse(raw), raw };
  }
  return { root, products, evidence, plist, run };
}
function uiTarget(extra = {}) {
  return {
    BlueprintName: "OmnesisDesktopUITests",
    TestHostPath: "__TESTROOT__/Debug/OmnesisDesktopUITests-Runner.app",
    TestBundlePath: "__TESTHOST__/Contents/PlugIns/OmnesisDesktopUITests.xctest",
    UITargetAppPath: "__TESTROOT__/Debug/Omnesis.app",
    ...extra,
  };
}
posix.each([false, true])(
  "projects v1 XML/binary fixture plists without leaking environment or argument contents (%s)",
  (binary) => {
    const f = fixture();
    const secret = "invented-private-value-not-for-projection";
    f.plist(
      {
        OmnesisDesktopUITests: uiTarget({
          EnvironmentVariables: { [secret]: secret },
          TestingEnvironmentVariables: { TOKEN: secret },
          UITargetAppCommandLineArguments: [secret],
          [secret]: secret,
        }),
      },
      binary,
    );
    const { value, raw } = f.run();
    expect(value.result).toBe("observed");
    expect(value.manifests[0].sha256).toMatch(/^[a-f0-9]{64}$/u);
    const schema = value.manifests[0].schema;
    expect(schema.formatVersion).toBe(1);
    expect(schema.configurations[0].targets[0].paths.UITargetAppPath).toEqual({
      kind: "testroot",
      path: "Debug/Omnesis.app",
    });
    expect(schema.configurations[0].targets[0].topology.fields.EnvironmentVariables).toBe(
      "dictionary",
    );
    expect(raw).not.toContain(secret);
  },
);
posix(
  "observes enabled and disabled v2 target selection and redacts unrecognized configuration names and paths",
  () => {
    const f = fixture();
    f.plist({
      __xctestrun_metadata__: { FormatVersion: 2 },
      TestConfigurations: [
        { Name: "private-config-label", IsEnabled: false, TestTargets: [uiTarget()] },
        {
          IsEnabled: true,
          TestTargets: [
            uiTarget({
              UITargetAppPath: join(f.products, "Debug/Omnesis.app"),
              TestBundlePath: "/outside/private-target",
            }),
            { BlueprintName: "private-target-name", UITargetAppPath: "/outside/secret" },
          ],
        },
      ],
    });
    const { value, raw } = f.run();
    const configs = value.manifests[0].schema.configurations;
    expect(configs.map((c) => c.enabled)).toEqual([false, true]);
    expect(configs[1].targets[0].paths.TestBundlePath).toEqual({ kind: "outside-testroot" });
    expect(configs[1].targets[1].blueprint).toBe("other");
    expect(raw).not.toMatch(
      /private-config-label|private-target-name|private-target|outside\/secret/u,
    );
  },
);
posix.each([
  "__TESTROOT__/../private/secret",
  "__TESTROOT__/Debug/private-name.app",
  "file:///private/secret",
  "bad\npath",
])("redacts unsafe path content (%s)", (path) => {
  const f = fixture();
  f.plist({ OmnesisDesktopUITests: uiTarget({ UITargetAppPath: path }) });
  const { value, raw } = f.run();
  expect(value.manifests[0].schema.configurations[0].targets[0].paths.UITargetAppPath.kind).toMatch(
    /refused|unrecognized-path/u,
  );
  expect(raw).not.toContain("secret");
});
posix.each(["symlink", "hardlink", "oversize", "malformed", "writable", "too-many"])(
  "refuses actual unsafe generated inputs (%s)",
  (scenario) => {
    const f = fixture();
    f.plist({ OmnesisDesktopUITests: uiTarget() });
    const path = join(f.products, "fixture.xctestrun");
    if (scenario === "symlink") {
      rmSync(path);
      symlinkSync("missing", path);
    }
    if (scenario === "hardlink") {
      const result = spawnSync("python3", [
        "-c",
        "import os,sys;os.link(sys.argv[1],sys.argv[2])",
        path,
        join(f.root, "other"),
      ]);
      expect(result.status).toBe(0);
    }
    if (scenario === "oversize") writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
    if (scenario === "malformed") writeFileSync(path, "invented-invalid-plist");
    if (scenario === "writable") chmodSync(path, 0o666);
    if (scenario === "too-many")
      for (let i = 0; i < 4; i++) f.plist({}, false, `extra-${i}.xctestrun`);
    expect(f.run().value).toEqual({ format: 1, result: "refused", manifests: [] });
  },
);
posix("does not follow an evidence-parent symlink or change its foreign destination", () => {
  const f = fixture(),
    foreign = join(f.root, "foreign");
  mkdirSync(foreign);
  symlinkSync(foreign, f.evidence);
  const result = spawnSync("python3", [helper, "--products", f.products, "--evidence", f.evidence]);
  expect(result.status).toBe(1);
  expect(readdirSync(foreign)).toEqual([]);
});
posix(
  "records absence and unknown schema honestly without interpreting it as executable selection",
  () => {
    const empty = fixture();
    expect(empty.run().value.result).toBe("absent");
    const unknown = fixture();
    unknown.plist({ __xctestrun_metadata__: { FormatVersion: 99 }, PrivateKey: "secret" });
    expect(unknown.run().value.manifests[0].schema).toMatchObject({
      formatVersion: "unknown",
      configurations: [],
    });
  },
);

posix("refuses a linked products directory rather than following its manifest", () => {
  const f = fixture();
  f.plist({ OmnesisDesktopUITests: uiTarget() });
  const alias = join(f.root, "products-alias");
  symlinkSync(f.products, alias);
  const result = spawnSync("python3", [helper, "--products", alias, "--evidence", f.evidence]);
  expect(result.status).toBe(0);
  const leaf = readdirSync(f.evidence)[0];
  expect(JSON.parse(readFileSync(join(f.evidence, leaf, "latest.txt"), "utf8"))).toEqual({
    format: 1,
    result: "refused",
    manifests: [],
  });
});

posix("refuses over-cap configuration topology with a finite receipt", () => {
  const f = fixture();
  f.plist({
    __xctestrun_metadata__: { FormatVersion: 2 },
    TestConfigurations: Array.from({ length: 9 }, () => ({ TestTargets: [] })),
  });
  expect(f.run().value).toEqual({ format: 1, result: "refused", manifests: [] });
});
