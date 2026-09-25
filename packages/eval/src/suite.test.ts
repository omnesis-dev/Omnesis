// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadSuite, resolveSuitePath, collectAllUrls } from "./suite.js";

function writeSuite(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-suite-"));
  const path = join(dir, "s.yaml");
  writeFileSync(path, yaml);
  return path;
}

describe("resolveSuitePath", () => {
  it("maps bare names under configDir/evals/suites/<name>.yaml", () => {
    expect(resolveSuitePath("my-eval", "/tmp/cfg")).toBe("/tmp/cfg/evals/suites/my-eval.yaml");
  });
  it("treats *.yaml as an explicit path", () => {
    expect(resolveSuitePath("/abs/path.yaml")).toBe("/abs/path.yaml");
  });
  it("treats './' prefix as a relative path", () => {
    expect(resolveSuitePath("./local.yaml").endsWith("/local.yaml")).toBe(true);
  });
});

describe("loadSuite", () => {
  it("loads the minimal form", () => {
    const path = writeSuite(`
description: t
version: 1
queries:
  - id: q1
    query: hello
    expected_url: https://example.com/a
`);
    const suite = loadSuite(path);
    expect(suite.defaultTopK).toBe(10);
    expect(suite.queries).toHaveLength(1);
    expect(suite.queries[0]!.expectedDocs).toEqual([{ urls: ["https://example.com/a"] }]);
    expect(suite.queries[0]!.topK).toBe(10);
    expect(suite.sha256).toHaveLength(64);
  });

  it("keeps URLs verbatim from YAML (normalization is the gateway's job)", () => {
    const path = writeSuite(`
description: t
version: 1
queries:
  - id: q1
    query: hello
    expected_url: https://example.com/a?utm_source=email#section
`);
    const suite = loadSuite(path);
    expect(suite.queries[0]!.expectedDocs[0]!.urls[0]).toBe(
      "https://example.com/a?utm_source=email#section",
    );
  });

  it("collapses expected_url and expected_urls into expectedDocs[]", () => {
    const path = writeSuite(`
description: t
version: 1
queries:
  - id: q1
    query: multi
    expected_urls:
      - https://example.com/a
      - aliases:
          - https://example.com/b
          - https://example.com/b?utm_campaign=x
      - https://example.com/c
`);
    const suite = loadSuite(path);
    const docs = suite.queries[0]!.expectedDocs;
    expect(docs).toHaveLength(3);
    expect(docs[1]!.urls).toEqual([
      "https://example.com/b",
      "https://example.com/b?utm_campaign=x",
    ]);
    expect(docs[2]!.urls).toEqual(["https://example.com/c"]);
  });

  it("honors per-query top_k override + default", () => {
    const path = writeSuite(`
description: t
version: 1
default_top_k: 5
queries:
  - id: q1
    query: x
    expected_url: https://example.com/a
  - id: q2
    query: x
    expected_url: https://example.com/b
    top_k: 20
`);
    const suite = loadSuite(path);
    expect(suite.queries[0]!.topK).toBe(5);
    expect(suite.queries[1]!.topK).toBe(20);
  });

  it("keeps unexpected_urls verbatim too", () => {
    const path = writeSuite(`
description: t
version: 1
queries:
  - id: q1
    query: x
    expected_url: https://example.com/a
    unexpected_urls:
      - https://example.com/junk?utm_source=foo
`);
    const suite = loadSuite(path);
    expect(suite.queries[0]!.unexpectedUrls).toEqual(["https://example.com/junk?utm_source=foo"]);
  });

  it("rejects duplicate query ids", () => {
    const path = writeSuite(`
description: t
version: 1
queries:
  - id: q1
    query: a
    expected_url: https://example.com/a
  - id: q1
    query: b
    expected_url: https://example.com/b
`);
    expect(() => loadSuite(path)).toThrow(/duplicate query id/);
  });

  it("rejects a query with no expected URL at all", () => {
    const path = writeSuite(`
description: t
version: 1
queries:
  - id: q1
    query: a
`);
    expect(() => loadSuite(path)).toThrow();
  });

  it("collectAllUrls deduplicates across queries", () => {
    const path = writeSuite(`
description: t
version: 1
queries:
  - id: q1
    query: a
    expected_url: https://example.com/a
  - id: q2
    query: b
    expected_url: https://example.com/a
    unexpected_urls:
      - https://example.com/junk
`);
    const suite = loadSuite(path);
    expect(collectAllUrls(suite).sort()).toEqual(
      ["https://example.com/a", "https://example.com/junk"].sort(),
    );
  });
});
