// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseArgs, type ArgsDef, type CommandDef } from "citty";
import { describe, expect, it } from "vitest";
import { graphCommand, buildWalkBody } from "./graph.js";

async function argsDefOf(sub: string): Promise<ArgsDef> {
  const subs = (await graphCommand.subCommands) as unknown as Record<string, CommandDef>;
  const cmd = subs[sub];
  return (typeof cmd.args === "function" ? await cmd.args() : cmd.args!) as ArgsDef;
}

describe("graph walk — arg parsing", () => {
  it("parses the start positional and filter flags", async () => {
    const def = await argsDefOf("walk");
    const parsed = parseArgs(
      ["a3f2c1b8", "--edges", "contains,url", "--hops", "3", "--provenance", "source-declared"],
      def,
    );
    expect(parsed.start).toBe("a3f2c1b8");
    expect(parsed.edges).toBe("contains,url");
    expect(parsed.hops).toBe("3");
    expect(parsed.provenance).toBe("source-declared");
  });
});

describe("graph walk — buildWalkBody", () => {
  it("composes a document seed + CSV filters into the request body", () => {
    const body = buildWalkBody({
      start: "doc-1",
      edges: "contains, url",
      "vertex-types": "document,person",
      hops: "5",
      "max-results": "200",
      "fanout-cap": "20",
      provenance: "source-declared,content-derived",
      "min-score": "0.7",
      "bound-rows": true,
    });
    expect(body).toEqual({
      start: [{ kind: "document", id: "doc-1" }],
      edgeTypes: ["contains", "url"],
      vertexTypes: ["document", "person"],
      maxHops: 5,
      maxResults: 200,
      fanoutCap: 20,
      provenanceKinds: ["source-declared", "content-derived"],
      minScore: 0.7,
      includeBoundRows: true,
    });
  });

  it("leaves omitted filters undefined and defaults bound-rows to false", () => {
    const body = buildWalkBody({ start: "doc-1" });
    expect(body.edgeTypes).toBeUndefined();
    expect(body.maxHops).toBeUndefined();
    expect(body.minScore).toBeUndefined();
    expect(body.includeBoundRows).toBe(false);
  });

  it("throws on a missing start positional", () => {
    expect(() => buildWalkBody({})).toThrow();
  });

  it("throws on out-of-range --hops", () => {
    expect(() => buildWalkBody({ start: "d", hops: "99" })).toThrow();
    expect(() => buildWalkBody({ start: "d", hops: "0" })).toThrow();
  });

  it("throws on non-numeric --hops", () => {
    expect(() => buildWalkBody({ start: "d", hops: "abc" })).toThrow();
  });

  it("throws on --min-score outside [0,1]", () => {
    expect(() => buildWalkBody({ start: "d", "min-score": "1.5" })).toThrow();
    expect(() => buildWalkBody({ start: "d", "min-score": "-0.1" })).toThrow();
  });
});
