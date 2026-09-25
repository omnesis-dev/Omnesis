// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { orderByDependencies, publishGraph } from "./publish-graph.mjs";
import { listPublishablePackages } from "./stage-packages.mjs";

describe("orderByDependencies", () => {
  const entry = (name, deps = {}, field = "dependencies") => ({
    dir: name,
    pkg: { name, version: "1.0.0", [field]: deps },
  });

  test("puts every workspace dependency before its dependents and keeps ties in input order", () => {
    const ordered = orderByDependencies([
      entry("app", { lib: "*", other: "*" }),
      entry("lib", { core: "*" }),
      entry("other", { core: "*" }),
      entry("core", { "left-pad": "^1.0.0" }),
      entry("standalone"),
    ]).map((e) => e.pkg.name);
    expect(ordered).toEqual(["core", "lib", "other", "app", "standalone"]);
  });

  test("follows peer and optional dependencies too", () => {
    const ordered = orderByDependencies([
      entry("app", { plugin: "*" }, "optionalDependencies"),
      entry("plugin", { core: "*" }, "peerDependencies"),
      entry("core"),
    ]).map((e) => e.pkg.name);
    expect(ordered).toEqual(["core", "plugin", "app"]);
  });

  test("publishes the members of a cycle consecutively, after what they depend on", () => {
    const ordered = orderByDependencies([
      entry("app", { a: "*" }),
      entry("a", { b: "*", core: "*" }),
      entry("b", { a: "*", core: "*" }),
      entry("core"),
    ]).map((e) => e.pkg.name);
    expect(ordered).toEqual(["core", "b", "a", "app"]);
  });
});

describe("the real package graph", () => {
  test("orders every publishable package with the entry package after its dependencies", () => {
    const packages = listPublishablePackages();
    const ordered = orderByDependencies(packages).map((e) => e.pkg.name);
    expect(ordered).toHaveLength(packages.length);
    expect(new Set(ordered).size).toBe(packages.length);
    const position = new Map(ordered.map((name, index) => [name, index]));
    const entry = packages.find((e) => e.pkg.name === "omnesis");
    const closure = new Set();
    const collect = (pkg) => {
      for (const dependency of Object.keys(pkg.dependencies ?? {})) {
        const target = packages.find((e) => e.pkg.name === dependency);
        if (target && !closure.has(dependency)) {
          closure.add(dependency);
          collect(target.pkg);
        }
      }
    };
    collect(entry.pkg);
    expect(closure.size).toBeGreaterThan(5);
    for (const dependency of closure) {
      expect(position.get(dependency)).toBeLessThan(position.get("omnesis"));
    }
  });
});

/**
 * A disposable npm-compatible registry: enough of the publish, packument
 * and dist-tag protocol for npm's own CLI to publish, view and tag
 * against it, with a switch to fail one publish so a run can be interrupted
 * partway through the graph.
 */
function startFakeRegistry() {
  const packages = new Map();
  const state = { failPublishOf: null, publishes: [] };
  const packument = (name) => {
    const pkg = packages.get(name);
    if (!pkg) return null;
    return { name, "dist-tags": pkg.distTags, versions: pkg.versions };
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = decodeURIComponent(req.url.split("?")[0]);
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const tagsMatch = url.match(/^\/-\/package\/(.+)\/dist-tags$/u);
      if (req.method === "GET" && tagsMatch) {
        const pkg = packages.get(tagsMatch[1]);
        return pkg ? send(200, pkg.distTags) : send(404, { error: "not found" });
      }
      const tagMatch = url.match(/^\/-\/package\/(.+)\/dist-tags\/([^/]+)$/u);
      if (req.method === "PUT" && tagMatch) {
        const pkg = packages.get(tagMatch[1]);
        if (!pkg) return send(404, { error: "not found" });
        pkg.distTags[tagMatch[2]] = JSON.parse(body);
        return send(201, { ok: true });
      }
      if (req.method === "GET") {
        const doc = packument(url.slice(1));
        return doc ? send(200, doc) : send(404, { error: "not found" });
      }
      if (req.method === "PUT") {
        const name = url.slice(1);
        const doc = JSON.parse(body);
        // Keeps failing until the test clears it, so the interrupted run
        // stays interrupted however npm retries.
        if (state.failPublishOf === name) return send(500, { error: "registry hiccup" });
        const pkg = packages.get(name) ?? { versions: {}, distTags: {} };
        for (const [version, manifest] of Object.entries(doc.versions ?? {})) {
          if (pkg.versions[version]) {
            return send(403, { error: "cannot publish over previously published version" });
          }
          pkg.versions[version] = manifest;
          state.publishes.push(`${name}@${version}`);
        }
        Object.assign(pkg.distTags, doc["dist-tags"] ?? {});
        packages.set(name, pkg);
        return send(201, { ok: true });
      }
      return send(405, { error: "unsupported" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        state,
        packages,
        seed(name, version, manifest, distTags = {}) {
          const pkg = packages.get(name) ?? { versions: {}, distTags: {} };
          pkg.versions[version] = manifest;
          Object.assign(pkg.distTags, distTags);
          packages.set(name, pkg);
        },
        distTagsOf: (name) => packages.get(name)?.distTags ?? {},
        integrityOf: (name, version) => packages.get(name)?.versions[version]?.dist?.integrity,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** Three tiny packages with a chain of workspace dependencies, given in the wrong order. */
function writeGraph(root) {
  const write = (dir, pkg) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(join(root, dir, "index.js"), `module.exports = ${JSON.stringify(pkg.name)};\n`);
    return { dir: join(root, dir), pkg };
  };
  return [
    write("app", {
      name: "example-test-app",
      version: "1.0.0",
      dependencies: { "@example-test/beta": "1.0.0" },
    }),
    write("beta", {
      name: "@example-test/beta",
      version: "1.0.0",
      dependencies: { "@example-test/alpha": "1.0.0" },
    }),
    write("alpha", { name: "@example-test/alpha", version: "1.0.0" }),
  ];
}

describe("publishGraph against a disposable registry", () => {
  let registry;
  let root;
  let userconfig;
  let previousUserconfig;

  beforeAll(async () => {
    registry = await startFakeRegistry();
    root = mkdtempSync(join(tmpdir(), "omnesis-publish-graph-"));
    // npm refuses to publish without a credential for the registry; the
    // fake one accepts any token. Retries are off so a deliberately failed
    // publish fails at once instead of after npm's backoff, and the update
    // notifier is off so no child npm reaches the public registry.
    userconfig = join(root, ".npmrc");
    writeFileSync(
      userconfig,
      `//${registry.host}/:_authToken=test-token\nfetch-retries=0\nupdate-notifier=false\n`,
    );
    previousUserconfig = process.env.NPM_CONFIG_USERCONFIG;
    process.env.NPM_CONFIG_USERCONFIG = userconfig;
  });

  afterAll(async () => {
    if (previousUserconfig === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
    else process.env.NPM_CONFIG_USERCONFIG = previousUserconfig;
    await registry.close();
    rmSync(root, { recursive: true, force: true });
  });

  let packages;
  let tarballDir;
  let lines;
  const run = (overrides = {}) =>
    publishGraph({
      packages,
      registry: registry.url,
      tag: "latest",
      access: "public",
      stagingBase: join(root, "staging"),
      tarballDir,
      // The fixture directories are already publish-ready, so staging is
      // the identity; the real publisher injects stage-packages.mjs here.
      stage: (entry) => entry.dir,
      log: (line) => lines.push(line),
      ...overrides,
    });

  beforeEach(() => {
    registry.packages.clear();
    registry.state.publishes.length = 0;
    registry.state.failPublishOf = null;
    const scenario = mkdtempSync(join(root, "scenario-"));
    packages = writeGraph(scenario);
    tarballDir = join(scenario, "tarballs");
    lines = [];
  });

  test("a clean first publish lands the whole graph, dependencies first", async () => {
    const results = await run();
    expect(registry.state.publishes).toEqual([
      "@example-test/alpha@1.0.0",
      "@example-test/beta@1.0.0",
      "example-test-app@1.0.0",
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["published", "published", "published"]);
    expect(lines.at(-1)).toMatch(/^3 published, 0 already published \(/u);
    for (const name of ["@example-test/alpha", "@example-test/beta", "example-test-app"]) {
      expect(registry.distTagsOf(name)).toEqual({ latest: "1.0.0" });
    }
  }, 60_000);

  test("an interrupted publish resumes: the landed prefix is skipped, the rest publishes, the tag holds", async () => {
    registry.state.failPublishOf = "@example-test/beta";
    await expect(run()).rejects.toThrow(/@example-test\/beta@1\.0\.0 failed to publish/u);
    expect(registry.state.publishes).toEqual(["@example-test/alpha@1.0.0"]);
    expect(lines.at(-1)).toMatch(/^1 published, 0 already published, 1 failed, 1 not attempted/u);

    registry.state.failPublishOf = null;
    lines = [];
    const results = await run();
    expect(results).toEqual([
      { name: "@example-test/alpha", outcome: "already-published" },
      { name: "@example-test/beta", outcome: "published" },
      { name: "example-test-app", outcome: "published" },
    ]);
    expect(registry.state.publishes).toEqual([
      "@example-test/alpha@1.0.0",
      "@example-test/beta@1.0.0",
      "example-test-app@1.0.0",
    ]);
    expect(lines.at(-1)).toMatch(/^2 published, 1 already published \(/u);
    for (const name of ["@example-test/alpha", "@example-test/beta", "example-test-app"]) {
      expect(registry.distTagsOf(name).latest).toBe("1.0.0");
    }
  }, 120_000);

  test("a version the registry already holds byte for byte is reported complete and left alone", async () => {
    await run();
    const before = registry.integrityOf("@example-test/alpha", "1.0.0");
    lines = [];
    const results = await run();
    expect(results.map((r) => r.outcome)).toEqual([
      "already-published",
      "already-published",
      "already-published",
    ]);
    expect(registry.state.publishes).toHaveLength(3);
    expect(registry.integrityOf("@example-test/alpha", "1.0.0")).toBe(before);
    expect(lines.at(-1)).toMatch(/^0 published, 3 already published \(/u);
  }, 120_000);

  test("an older version on the registry does not count as this one", async () => {
    registry.seed("@example-test/beta", "0.9.0", {
      name: "@example-test/beta",
      version: "0.9.0",
      dist: { integrity: "sha512-older", tarball: `${registry.url}/older.tgz` },
    });
    const results = await run();
    expect(results.map((r) => r.outcome)).toEqual(["published", "published", "published"]);
    expect(registry.distTagsOf("@example-test/beta")).toEqual({ latest: "1.0.0" });
  }, 60_000);

  test("a different artifact under the same version stops the run before anything after it", async () => {
    registry.seed(
      "@example-test/beta",
      "1.0.0",
      {
        name: "@example-test/beta",
        version: "1.0.0",
        dist: { integrity: "sha512-somebodyelses", tarball: `${registry.url}/beta.tgz` },
      },
      { latest: "1.0.0" },
    );
    await expect(run()).rejects.toThrow(
      /@example-test\/beta@1\.0\.0 already exists on .* with a different artifact .*nothing after it was published/u,
    );
    expect(registry.state.publishes).toEqual(["@example-test/alpha@1.0.0"]);
    expect(registry.packages.has("example-test-app")).toBe(false);
    expect(lines.at(-1)).toMatch(
      /^1 published, 0 already published, 1 mismatched, 1 not attempted/u,
    );
  }, 60_000);

  test("a complete version tagged elsewhere gets the requested dist-tag on resume", async () => {
    await run();
    registry.distTagsOf("@example-test/alpha").latest = "0.0.1";
    lines = [];
    const results = await run();
    expect(results[0]).toEqual({
      name: "@example-test/alpha",
      outcome: "already-published",
      detail: "tagged latest",
    });
    expect(registry.distTagsOf("@example-test/alpha").latest).toBe("1.0.0");
  }, 120_000);

  test("a registry that cannot answer the version check stops the run as that package's failure", async () => {
    await expect(
      run({
        view: async (name) => {
          if (name === "@example-test/beta") throw new Error("registry unreachable");
          return null;
        },
      }),
    ).rejects.toThrow(/@example-test\/beta@1\.0\.0 failed to publish: registry unreachable/u);
    expect(registry.state.publishes).toEqual(["@example-test/alpha@1.0.0"]);
    expect(lines.at(-1)).toMatch(/^1 published, 0 already published, 1 failed, 1 not attempted/u);
  }, 60_000);

  test("a dry run packs every package and touches no registry", async () => {
    const results = await run({ dryRun: true });
    expect(results.map((r) => r.outcome)).toEqual(["packed", "packed", "packed"]);
    expect(registry.state.publishes).toEqual([]);
    expect(lines.at(-1)).toBe("3 packages packed");
  }, 60_000);

  test("a package that cannot be packed stops the run before the first publish", async () => {
    await expect(
      run({
        pack: async (stageDir, dir) => {
          if (stageDir.endsWith("beta")) throw new Error("beta is not packable");
          return { integrity: "sha512-x", tarball: join(dir, "x.tgz") };
        },
      }),
    ).rejects.toThrow(/beta is not packable/u);
    expect(registry.state.publishes).toEqual([]);
  });
});
