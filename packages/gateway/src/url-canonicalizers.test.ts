// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeUrl } from "@omnesis/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  getUrlCanonicalizers,
  resetUrlCanonicalizers,
  setExpectedUrlCanonicalizerDeclarers,
  setUrlCanonicalizersForDeclarer,
} from "./url-canonicalizers.js";

afterEach(() => resetUrlCanonicalizers());

describe("URL canonicalizer declarations", () => {
  const spec = (host: string) => ({ hosts: [host], rules: [] });

  test("merges sibling collectors instead of letting the last POST erase the first", () => {
    setExpectedUrlCanonicalizerDeclarers(["collector-a", "collector-b"]);
    setUrlCanonicalizersForDeclarer("collector-a", [spec("one.example.org")]);
    setUrlCanonicalizersForDeclarer("collector-b", [spec("two.example.org")]);

    expect([...getUrlCanonicalizers().keys()].sort()).toEqual([
      "one.example.org",
      "two.example.org",
    ]);
  });

  test("removes only a departed collector's contribution", () => {
    setExpectedUrlCanonicalizerDeclarers(["collector-a", "collector-b"]);
    setUrlCanonicalizersForDeclarer("collector-a", [spec("one.example.org")]);
    setUrlCanonicalizersForDeclarer("collector-b", [spec("two.example.org")]);

    setExpectedUrlCanonicalizerDeclarers(["collector-b"]);
    expect([...getUrlCanonicalizers().keys()]).toEqual(["two.example.org"]);
  });

  test("coalesces identical host rules and rejects conflicting sibling rules atomically", () => {
    const first = {
      hosts: ["shared.example.org"],
      rules: [
        {
          match: "^https://shared[.]example[.]org/(.*)$",
          replacement: "https://shared.example.org/$1",
        },
      ],
    };
    setUrlCanonicalizersForDeclarer("collector-b", [first]);
    setUrlCanonicalizersForDeclarer("collector-a", [first]);
    expect([...getUrlCanonicalizers().keys()]).toEqual(["shared.example.org"]);

    expect(() =>
      setUrlCanonicalizersForDeclarer("collector-c", [
        {
          hosts: ["shared.example.org"],
          rules: [{ match: "^(.*)$", replacement: "https://different.example.org/$1" }],
        },
      ]),
    ).toThrow("conflicting URL canonicalizer declarations");
    expect(getUrlCanonicalizers().get("shared.example.org")?.rules).toMatchObject(first.rules);
  });

  test("treats host names case-insensitively when detecting conflicts", () => {
    setUrlCanonicalizersForDeclarer("collector-a", [
      { hosts: ["Shared.Example.Org"], rules: [{ match: "^one$", replacement: "one" }] },
    ]);
    expect(() =>
      setUrlCanonicalizersForDeclarer("collector-b", [
        { hosts: ["shared.example.org"], rules: [{ match: "^two$", replacement: "two" }] },
      ]),
    ).toThrow("conflicting URL canonicalizer declarations");
  });

  test("executes nested ambiguous repetitions through the linear-time runtime", () => {
    setUrlCanonicalizersForDeclarer("collector-a", [
      {
        hosts: ["code.example.org"],
        rules: [
          {
            match: "^https://code[.]example[.]org/((a|aa))+$",
            replacement: "https://code.example.org/$1",
          },
        ],
      },
    ]);

    const runtimeRule = getUrlCanonicalizers().get("code.example.org")?.rules[0];
    expect(runtimeRule?.apply).toBeTypeOf("function");
    expect(
      normalizeUrl(`https://code.example.org/${"a".repeat(10_000)}b`, getUrlCanonicalizers()),
    ).toBe(`https://code.example.org/${"a".repeat(10_000)}b`);
  });

  test("releases replaced native registries during sustained collector declaration churn", () => {
    for (let generation = 0; generation < 2_000; generation += 1) {
      setUrlCanonicalizersForDeclarer("collector-a", [
        {
          hosts: ["updates.example.org"],
          rules: Array.from({ length: 8 }, (_, index) => ({
            match: `[?&]revision${index}=${generation}[^#&]*`,
            replacement: "",
          })),
        },
      ]);
    }

    expect([...getUrlCanonicalizers().keys()]).toEqual(["updates.example.org"]);
  });
});
