// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { evaluationSteps, readModuleGraph, type ModuleGraph } from "./module-graph.js";

function graph(edges: Record<string, string[]>, formats: Record<string, string> = {}): ModuleGraph {
  const urls = new Set([...Object.keys(edges), ...Object.values(edges).flat()]);
  return {
    requests: Object.entries(edges),
    formats: [...urls].map((url) => [url, formats[url] ?? "module"]),
  };
}

describe("evaluationSteps", () => {
  it("imports an acyclic graph one module at a time, in V8's depth-first finishing order", () => {
    const steps = evaluationSteps(
      "root",
      graph({ root: ["a", "b"], a: ["c", "d"], b: ["d", "e"], d: ["e"] }),
    );
    expect(steps).toEqual(["c", "e", "d", "a", "b", "root"]);
  });

  it("imports a cycle through the module where the walk entered it, from its first member on", () => {
    // root → a → x → y → a closes a cycle entered at a; b finishes before any
    // cycle member, w after one, so only b is imported on its own.
    const steps = evaluationSteps(
      "root",
      graph({ root: ["a", "z"], a: ["b", "x", "w"], x: ["y"], y: ["a"], w: ["v"] }),
    );
    expect(steps).toEqual(["b", "a", "z", "root"]);
  });

  it("keeps a cycle that finishes after an enclosing cycle's first member inside that step", () => {
    // x finishes first and waits for a; the c ⇄ d cycle then finishes inside a's step.
    const steps = evaluationSteps(
      "root",
      graph({ root: ["a"], a: ["x", "c"], x: ["a"], c: ["d"], d: ["c"] }),
    );
    expect(steps).toEqual(["a", "root"]);
    // Finishing before any member of the enclosing cycle, c ⇄ d is a step of its own.
    expect(
      evaluationSteps("root", graph({ root: ["a"], a: ["b"], b: ["c", "a"], c: ["d"], d: ["c"] })),
    ).toEqual(["c", "a", "root"]);
  });

  it("imports a cycle that finishes on its own before the next module", () => {
    const steps = evaluationSteps(
      "root",
      graph({ root: ["a", "c"], a: ["b"], b: ["a"], c: [], self: ["self"] }),
    );
    expect(steps).toEqual(["a", "c", "root"]);
    expect(evaluationSteps("self", graph({ self: ["self"] }))).toEqual(["self"]);
  });

  it("leaves JSON and built-ins to their importers and ignores what CommonJS requires", () => {
    const steps = evaluationSteps(
      "root",
      graph(
        { root: ["data", "node:path", "lib"], lib: ["inner"] },
        { data: "json", "node:path": "builtin", lib: "commonjs", inner: "commonjs" },
      ),
    );
    expect(steps).toEqual(["lib", "root"]);
  });
});

describe("readModuleGraph", () => {
  const RUNTIME = new URL("../runtime.ts", import.meta.url).href;

  it("reads the gateway runtime's graph with every module's format", async () => {
    const graph = await readModuleGraph(RUNTIME, new AbortController().signal);
    expect(graph).toBeDefined();
    const formats = new Map(graph!.formats);
    expect(formats.get(RUNTIME)).toBe("module");
    const imports = new Map(graph!.requests).get(RUNTIME) ?? [];
    expect(imports).toContain(new URL("../server.ts", import.meta.url).href);
    expect(evaluationSteps(RUNTIME, graph!).at(-1)).toBe(RUNTIME);
  }, 60_000);

  it("gives up without a graph when startup stops", async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(await readModuleGraph(RUNTIME, aborted.signal)).toBeUndefined();
    const stopping = new AbortController();
    const reading = readModuleGraph(RUNTIME, stopping.signal);
    stopping.abort();
    expect(await reading).toBeUndefined();
  });
});

describe("importInSteps against Node's own evaluation", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const REGISTER_TSX = new URL("../workers/register-tsx.mjs", import.meta.url).href;
  const MODULE_GRAPH = new URL("./module-graph.ts", import.meta.url).href;

  /** Writes ESM fixtures that record their evaluation, and returns the root's URL. */
  function fixture(modules: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-module-graph-"));
    dirs.push(dir);
    for (const [name, source] of Object.entries(modules)) writeFileSync(join(dir, name), source);
    return pathToFileURL(join(dir, "root.mjs")).href;
  }

  const esm = (name: string, deps: string[], body = ""): string =>
    `${deps.map((dep) => `import "./${dep}";`).join("\n")}\n${body}\nglobalThis.order.push(${JSON.stringify(name)});\n`;

  /** Runs `script` in a fresh Node with the gateway's loader, and returns what it prints. */
  function run(root: string, script: string): { order: string[]; error?: string } {
    const result = spawnSync(
      process.execPath,
      ["--import", REGISTER_TSX, "--input-type=module", "-e", script, root, MODULE_GRAPH],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
      order: string[];
      error?: string;
    };
  }

  const NATURAL = `
    globalThis.order = [];
    const [root] = process.argv.slice(1);
    let error;
    try { await import(root); } catch (failure) { error = failure.name; }
    console.log(JSON.stringify({ order: globalThis.order, error }));
  `;

  const STAGED = `
    globalThis.order = [];
    const [root, moduleGraph] = process.argv.slice(1);
    const { importInSteps, readModuleGraph } = await import(moduleGraph);
    const controller = new AbortController();
    globalThis.abortLoading = () => controller.abort();
    const graph = readModuleGraph(root, controller.signal);
    globalThis.order.push(globalThis.graphRead = (await graph) ? "graph" : "no graph");
    const ticks = setInterval(() => globalThis.order.push("turn"), 1);
    let error;
    try { await importInSteps(root, graph, controller.signal); } catch (failure) { error = failure.name; }
    clearInterval(ticks);
    console.log(JSON.stringify({ order: globalThis.order, error }));
  `;

  const busy = "const until = Date.now() + 15; while (Date.now() < until);";

  it("evaluates every module in the order one import would, with event-loop turns between steps", () => {
    const root = fixture({
      "root.mjs": esm("root", ["a.mjs", "b.mjs", "c.mjs"]),
      // a ⇄ d is a cycle; e is reached from inside it.
      "a.mjs": esm("a", ["d.mjs", "e.mjs"], busy),
      "d.mjs": esm("d", ["a.mjs", "e.mjs"]),
      "e.mjs": esm("e", [], busy),
      // b → f → g → b is a cycle with an unrelated module finishing inside it.
      "b.mjs": esm("b", ["f.mjs", "h.mjs"]),
      "f.mjs": esm("f", ["g.mjs"]),
      "g.mjs": esm("g", ["b.mjs"]),
      "h.mjs": esm("h", ["d.mjs"], busy),
      // JSON, a built-in and CommonJS that requires more CommonJS.
      "c.mjs": `import data from "./data.json" with { type: "json" };\nimport "node:path";\nimport "./lib.cjs";\n${busy}\nglobalThis.order.push("c:" + data.name);\n`,
      "data.json": JSON.stringify({ name: "fixture" }),
      "lib.cjs": `require("./inner.cjs"); globalThis.order.push("lib");`,
      "inner.cjs": `globalThis.order.push("inner");`,
    });
    const natural = run(root, NATURAL);
    const staged = run(root, STAGED);
    expect(natural.order).toEqual([
      "e",
      "d",
      "a",
      "g",
      "f",
      "h",
      "b",
      "inner",
      "lib",
      "c:fixture",
      "root",
    ]);
    expect(staged.order[0]).toBe("graph");
    const evaluated = staged.order.filter((entry) => entry !== "turn" && entry !== "graph");
    expect(evaluated).toEqual(natural.order);
    const firstModule = staged.order.indexOf(evaluated[0]!);
    const lastModule = staged.order.lastIndexOf(evaluated.at(-1)!);
    expect(staged.order.slice(firstModule, lastModule)).toContain("turn");
  });

  it("stops between steps when startup is aborted", () => {
    const root = fixture({
      "root.mjs": esm("root", ["a.mjs", "b.mjs"]),
      "a.mjs": esm("a", [], "globalThis.abortLoading?.();"),
      "b.mjs": esm("b", []),
    });
    const staged = run(root, STAGED);
    expect(staged.error).toBe("AbortError");
    expect(staged.order.filter((entry) => entry !== "turn")).toEqual(["graph", "a"]);
  });

  it("loads in one step, with the same failure, when the graph cannot be read", () => {
    const root = fixture({
      "root.mjs": esm("root", ["a.mjs", "broken.mjs"]),
      "a.mjs": esm("a", []),
      "broken.mjs": "export const = ;",
    });
    const natural = run(root, NATURAL);
    const staged = run(root, STAGED);
    expect(natural.error).toBe("SyntaxError");
    expect(staged.error).toBe("SyntaxError");
    expect(staged.order.filter((entry) => entry !== "turn")).toEqual(["no graph"]);
  });
});
