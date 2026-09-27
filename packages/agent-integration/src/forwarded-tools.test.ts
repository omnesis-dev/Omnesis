// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  FORWARDED_TOOLS_RETRY_MS,
  FORWARDED_TOOLS_STALE_MS,
  ForwardedToolCatalogue,
  forwardedToolOutcome,
  forwardedToolsFromListing,
  readForwardedToolCache,
} from "./forwarded-tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-forwarded-tools-"));
  tempDirs.push(dir);
  return join(dir, "mcp-tools.json");
}

const objectSchema = { type: "object", properties: {} };

function listed(name: string, description = `The fictional ${name} tool.`) {
  return { name, title: `Fictional ${name}`, description, inputSchema: objectSchema };
}

describe("which listed tools an integration hosts", () => {
  test("keeps the Direct and Notes tools in offering order and leaves Answer to its own tools", () => {
    const tools = forwardedToolsFromListing([
      listed("add_note"),
      listed("ask_omnesis"),
      listed("run_sql"),
      listed("get_answer_status"),
      listed("list_tables"),
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["run_sql", "list_tables", "add_note"]);
    expect(tools[0]).toEqual({
      name: "run_sql",
      title: "Fictional run_sql",
      description: "The fictional run_sql tool.",
      inputSchema: objectSchema,
    });
  });

  test("drops a tool it cannot host or cannot describe without failing the rest", () => {
    const tools = forwardedToolsFromListing([
      listed("a_future_tool"),
      { name: "run_sql", description: "", inputSchema: objectSchema },
      { name: "list_tables", description: "Fictional.", inputSchema: { type: "array" } },
      "not a tool",
      listed("add_note"),
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["add_note"]);
  });
});

describe("what a forwarded call returns", () => {
  test("joins the gateway's text and keeps its structured result", () => {
    expect(
      forwardedToolOutcome({
        content: [
          { type: "text", text: "First line." },
          { type: "image", data: "", mimeType: "image/png" },
          { type: "text", text: "Second line." },
        ],
        structuredContent: { kind: "ok", rows: [] },
      }),
    ).toEqual({
      isError: false,
      text: "First line.\nSecond line.",
      structuredContent: { kind: "ok", rows: [] },
    });
  });

  test("carries the gateway's own error flag", () => {
    expect(
      forwardedToolOutcome({ content: [{ type: "text", text: "Refused." }], isError: true }),
    ).toEqual({ isError: true, text: "Refused." });
  });
});

describe("the connection's tool catalogue", () => {
  test("starts from the last listing a previous process kept", async () => {
    const path = cachePath();
    writeFileSync(path, JSON.stringify({ tools: [listed("add_note"), listed("ask_omnesis")] }));
    const list = vi.fn(async () => {
      throw new Error("gateway unreachable");
    });
    const warn = vi.fn();
    const catalogue = new ForwardedToolCatalogue({ list, cachePath: path, logger: { warn } });
    expect(catalogue.current().map((tool) => tool.name)).toEqual(["add_note"]);
    await catalogue.idle();
    // The failed listing leaves the kept one standing.
    expect(catalogue.current().map((tool) => tool.name)).toEqual(["add_note"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/gateway unreachable/u));
  });

  test("offers nothing when no listing has ever landed", () => {
    const catalogue = new ForwardedToolCatalogue({
      list: async () => new Promise<never>(() => {}),
      cachePath: cachePath(),
      logger: { warn: vi.fn() },
    });
    expect(catalogue.current()).toEqual([]);
  });

  test("keeps a listing for the next process, readable only by its owner", async () => {
    const path = cachePath();
    const catalogue = new ForwardedToolCatalogue({
      list: async () => [listed("list_tables"), listed("run_sql")],
      cachePath: path,
      logger: { warn: vi.fn() },
    });
    await catalogue.refresh();
    expect(catalogue.current().map((tool) => tool.name)).toEqual(["run_sql", "list_tables"]);
    expect(readForwardedToolCache(path).map((tool) => tool.name)).toEqual([
      "run_sql",
      "list_tables",
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("re-reads a stale listing in the background and a failed one only after a pause", async () => {
    let clock = 1_000_000;
    let tools: unknown[] = [listed("run_sql")];
    let failing = false;
    const list = vi.fn(async () => {
      if (failing) throw new Error("gateway unreachable");
      return tools;
    });
    const catalogue = new ForwardedToolCatalogue({
      list,
      cachePath: cachePath(),
      logger: { warn: vi.fn() },
      now: () => clock,
    });
    await catalogue.refresh();
    expect(list).toHaveBeenCalledTimes(1);

    tools = [listed("run_sql"), listed("add_note")];
    clock += FORWARDED_TOOLS_STALE_MS - 1;
    expect(catalogue.current().map((tool) => tool.name)).toEqual(["run_sql"]);
    await catalogue.idle();
    expect(list).toHaveBeenCalledTimes(1);

    clock += 1;
    // The caller that finds it stale is offered what is known; the next one
    // gets the fresh listing.
    expect(catalogue.current().map((tool) => tool.name)).toEqual(["run_sql"]);
    await catalogue.idle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(catalogue.current().map((tool) => tool.name)).toEqual(["run_sql", "add_note"]);

    failing = true;
    clock += FORWARDED_TOOLS_STALE_MS;
    catalogue.current();
    await catalogue.idle();
    expect(list).toHaveBeenCalledTimes(3);
    clock += FORWARDED_TOOLS_RETRY_MS - 1;
    catalogue.current();
    await catalogue.idle();
    expect(list).toHaveBeenCalledTimes(3);
    clock += 1;
    catalogue.current();
    await catalogue.idle();
    expect(list).toHaveBeenCalledTimes(4);
    expect(catalogue.current().map((tool) => tool.name)).toEqual(["run_sql", "add_note"]);
  });

  test("an invalidated listing is re-read at once, joining one already under way", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = vi.fn(async () => {
      await gate;
      return [listed("add_note")];
    });
    const catalogue = new ForwardedToolCatalogue({
      list,
      cachePath: cachePath(),
      logger: { warn: vi.fn() },
    });
    const first = catalogue.refresh();
    catalogue.invalidate();
    catalogue.current();
    release();
    await first;
    expect(list).toHaveBeenCalledTimes(1);
    catalogue.invalidate();
    await catalogue.idle();
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("ignores a kept listing it cannot read", () => {
    const path = cachePath();
    writeFileSync(path, "not json");
    expect(readForwardedToolCache(path)).toEqual([]);
    writeFileSync(path, JSON.stringify({ tools: "nope" }));
    expect(readForwardedToolCache(path)).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain("nope");
  });
});
