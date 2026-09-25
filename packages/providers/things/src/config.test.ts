// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Things keeps its database in a container, and this declares that setting.
 *
 * This source is the reason the schema has an escape hatch at all. Its path is
 * optional, and blank does not mean "unset" — it means "use the database this
 * Mac already has", which is a claim that can be false. A declarative
 * constraint cannot express that, because there is no value to constrain.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hostConfigIssues, nodePathProbe } from "@omnesis/source-sdk";
import definition from "./index.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync: (path: Parameters<typeof fs.existsSync>[0]) =>
      String(path).endsWith("JLMPQHK86H.com.culturedcode.ThingsMac") ? false : fs.existsSync(path),
  };
});

describe("the Things database setting", () => {
  let dir: string;
  const schema = definition.config!;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "things-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a blank path is still checked, and says the database was not found", () => {
    // The check that only this source can make. Nothing was supplied, so
    // there is no path to test; the question is whether this machine has one.
    const issues = hostConfigIssues(schema, { dbPath: "" }, nodePathProbe);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/not found on this Mac/);
  });

  test("an omitted path is treated the same as a blank one", () => {
    // The two are the same operator gesture — the field was left alone — and
    // an answer that depended on which one the client sent would be a bug.
    expect(hostConfigIssues(schema, {}, nodePathProbe)).toHaveLength(1);
  });

  test("a database file that exists is accepted", () => {
    const db = join(dir, "main.sqlite");
    writeFileSync(db, "");
    expect(hostConfigIssues(schema, { dbPath: db }, nodePathProbe)).toEqual([]);
  });

  test("a path that does not exist is refused, and names the reason", () => {
    const issues = hostConfigIssues(schema, { dbPath: join(dir, "gone.sqlite") }, nodePathProbe);
    expect(issues[0]?.message).toMatch(/does not exist/i);
  });

  test("the form field still validates one value at a time", () => {
    // What the operator sees while typing, rather than after submitting.
    const validate = definition.params?.find((p) => p.name === "dbPath")?.validate;
    expect(validate).toBeTypeOf("function");
    expect(validate!("")).toMatch(/not found on this Mac/);
  });

  test("the form field asks to be validated even while it is blank", () => {
    const param = definition.params?.find((p) => p.name === "dbPath");
    expect(param?.validateWhenEmpty).toBe(true);
  });

  test("the setting stays member-scoped, because it names a file on one machine", () => {
    expect(definition.params?.find((p) => p.name === "dbPath")?.scope).toBe("member");
  });
});
