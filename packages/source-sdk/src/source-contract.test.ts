// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  checkContractCompatibility,
  mergeContractDeclarations,
  validateContractDeclaration,
  HOST_CAPABILITIES,
  MINIMUM_SOURCE_API_VERSION,
  SOURCE_API_VERSION,
  type SourceContractDeclaration,
} from "./source-contract.js";
import { defineSource, defineProvider } from "./define-source.js";
import { emptySync } from "./source.js";

const anyState = { version: 1, decode: (v: unknown) => v as Record<string, unknown> };

test.each([undefined, {}])("provider state is never inherited by child declaration %j", (entry) => {
  const merged = mergeContractDeclarations(
    { apiVersion: 2, state: anyState, requires: ["state-envelope"] },
    entry,
  );
  expect(merged).toMatchObject({ apiVersion: 2, requires: ["state-envelope"] });
  expect(merged?.state).toBeUndefined();
});

describe("api generation compatibility", () => {
  test("a package declaring nothing is generation 1 and loads", () => {
    expect(checkContractCompatibility(undefined, "x")).toBeNull();
    expect(checkContractCompatibility({}, "x")).toBeNull();
  });

  test("a package written for a newer generation is refused with an actionable message", () => {
    const result = checkContractCompatibility({ apiVersion: 9 }, "provider-acme", {
      apiVersion: 2,
    });
    expect(result?.kind).toBe("api-too-new");
    expect(result?.message).toContain("provider-acme");
    expect(result?.message).toContain("Upgrade the host");
  });

  test("a package below the host's floor is refused and told to update itself", () => {
    const result = checkContractCompatibility({ apiVersion: 1 }, "provider-acme", {
      apiVersion: 3,
      minimumApiVersion: 2,
    });
    expect(result?.kind).toBe("api-too-old");
    expect(result?.message).toContain("Update the source package");
  });

  test("this build still loads generation 1 packages", () => {
    // The whole tree is generation 1 until each package opts in, so lowering
    // this floor early would refuse every source at once.
    expect(MINIMUM_SOURCE_API_VERSION).toBe(1);
    expect(checkContractCompatibility({ apiVersion: 1 }, "x")).toBeNull();
  });
});

describe("required host capabilities", () => {
  test("a capability this build provides loads", () => {
    expect(checkContractCompatibility({ requires: ["state-envelope"] }, "x")).toBeNull();
  });

  test("a capability this build lacks is refused, naming what is missing", () => {
    const result = checkContractCompatibility(
      { requires: ["state-envelope", "snapshot-sessions"] },
      "provider-acme",
      { capabilities: ["state-envelope"] },
    );
    expect(result?.kind).toBe("missing-capability");
    expect(result?.capabilities).toEqual(["snapshot-sessions"]);
    expect(result?.message).toContain("silently drop");
  });

  test("refusing is the point: a missing deletion capability must not degrade quietly", () => {
    // A host that ignored `snapshot-sessions` would keep syncing and simply
    // never detect a deletion, which looks identical to a source with nothing
    // to delete. Refusing the package is the only way that is visible.
    const result = checkContractCompatibility({ requires: ["snapshot-sessions"] }, "x", {
      capabilities: [],
    });
    expect(result).not.toBeNull();
  });

  test("the advertised capability list is what a package can rely on today", () => {
    expect([...HOST_CAPABILITIES]).toEqual([
      "state-envelope",
      "multi-table-batch",
      "snapshot-sessions",
      "tuple-deletes",
      "scoped-host",
      "typed-config",
    ]);
    // Source IDs still carry legacy account spellings: do not advertise opaque
    // connection allocation merely because the type reserves its future name.
    expect(checkContractCompatibility({ requires: ["connection-identity"] }, "x")?.kind).toBe(
      "missing-capability",
    );
  });
});

describe("validateContractDeclaration", () => {
  test("accepts an empty declaration", () => {
    expect(() => validateContractDeclaration({}, "x")).not.toThrow();
    expect(() => validateContractDeclaration(undefined, "x")).not.toThrow();
  });

  test.each([
    ["zero", 0],
    ["negative", -2],
    ["fractional", 1.5],
  ])("rejects a %s apiVersion", (_l, apiVersion) => {
    expect(() => validateContractDeclaration({ apiVersion }, "x")).toThrow(/apiVersion must be/);
  });

  test("rejects an apiVersion ahead of the SDK it compiles against", () => {
    expect(() => validateContractDeclaration({ apiVersion: SOURCE_API_VERSION + 1 }, "x")).toThrow(
      /ahead of this SDK/,
    );
  });

  test("rejects an unknown capability name rather than ignoring it", () => {
    expect(() =>
      validateContractDeclaration(
        { requires: ["teleportation"] } as unknown as SourceContractDeclaration,
        "x",
      ),
    ).toThrow(/does not define: teleportation/);
  });

  test.each([
    ["zero", 0],
    ["fractional", 2.5],
  ])("rejects a %s outputRevision", (_l, outputRevision) => {
    expect(() => validateContractDeclaration({ outputRevision }, "x")).toThrow(
      /outputRevision must be/,
    );
  });

  test("versioned state with migrations must declare the capability it depends on", () => {
    expect(() =>
      validateContractDeclaration(
        {
          state: {
            version: 2,
            decode: (v) => v as Record<string, unknown>,
            migrate: { 1: (v) => v },
          },
        },
        "x",
      ),
    ).toThrow(/Declare requires: \["state-envelope"\]/);
  });

  test("version 1 state needs no capability declaration, because nothing migrates", () => {
    expect(() => validateContractDeclaration({ state: anyState }, "x")).not.toThrow();
  });

  test.each([{ onUnreadable: "stop" as const }, { maxBytes: 1024 }])(
    "version 1 state safety policy %j requires envelope support",
    (policy) => {
      const state = { ...anyState, ...policy };
      expect(() => validateContractDeclaration({ state }, "x")).toThrow(/state-envelope/);
      expect(() =>
        validateContractDeclaration({ state, requires: ["state-envelope"] }, "x"),
      ).not.toThrow();
    },
  );

  test("declaring the capability satisfies the check", () => {
    expect(() =>
      validateContractDeclaration(
        {
          requires: ["state-envelope"],
          state: {
            version: 2,
            decode: (v) => v as Record<string, unknown>,
            migrate: { 1: (v) => v },
          },
        },
        "x",
      ),
    ).not.toThrow();
  });

  test("a malformed state spec is reported through the same path", () => {
    expect(() =>
      validateContractDeclaration(
        {
          requires: ["state-envelope"],
          state: {
            version: 3,
            decode: (v) => v as Record<string, unknown>,
            migrate: { 1: (v) => v },
          },
        },
        "defineSource('x')",
      ),
    ).toThrow(/no migration from version 2/);
  });
});

describe("the define helpers enforce it at package load", () => {
  const base = {
    id: "acme",
    name: "Acme",
    description: "Acme data",
    authType: "local" as const,
    create: async () => ({ sync: async () => emptySync() }),
  };

  test("defineSource accepts a well-formed contract", () => {
    const def = defineSource({
      ...base,
      contract: { apiVersion: 2, outputRevision: 3, state: anyState },
    });
    expect(def.contract?.outputRevision).toBe(3);
  });

  test("defineSource throws on a migration hole, naming the source", () => {
    expect(() =>
      defineSource({
        ...base,
        contract: {
          requires: ["state-envelope"],
          state: {
            version: 3,
            decode: (v) => v as Record<string, unknown>,
            migrate: { 2: (v) => v },
          },
        },
      }),
    ).toThrow(/defineSource\('acme'\).*no migration from version 1/s);
  });

  test("defineProvider validates the provider block and every source entry", () => {
    expect(() =>
      defineProvider({
        provider: { id: "acme", name: "Acme" },
        authType: "oauth",
        sources: [
          {
            id: "acme-mail",
            name: "Acme mail",
            description: "Mail",
            contract: { apiVersion: 99 },
            create: async () => ({ sync: async () => emptySync() }),
          },
        ],
      }),
    ).toThrow(/defineProvider source 'acme-mail'.*ahead of this SDK/s);
  });

  test("a provider-level contract is validated too", () => {
    expect(() =>
      defineProvider({
        provider: { id: "acme", name: "Acme" },
        authType: "oauth",
        contract: { requires: ["nope"] } as unknown as SourceContractDeclaration,
        sources: [
          {
            id: "acme-mail",
            name: "Acme mail",
            description: "Mail",
            create: async () => ({ sync: async () => emptySync() }),
          },
        ],
      }),
    ).toThrow(/defineProvider\('acme'\)/);
  });
});
