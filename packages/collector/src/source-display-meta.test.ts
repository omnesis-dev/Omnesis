// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { AccountId, ProviderId, SourceId } from "@omnesis/types";
import { sourceDisplayMeta } from "./source-display-meta.js";
import type { RegisteredSource } from "./sync-engine-types.js";

function source(over: Partial<RegisteredSource> = {}): RegisteredSource {
  return {
    id: SourceId("example-bank:conn-1"),
    name: "an institution",
    providerId: ProviderId("example-bank:conn-1"),
    family: {
      name: "Accounts",
      icon: { sfSymbol: "banknote", url: "FAMILY_ICON", bgColor: "#111", color: "#eee" },
    },
    icon: { sfSymbol: "banknote", url: "OWN_ICON", bgColor: "#222", color: "#ddd" },
    instance: {
      id: SourceId("example-bank:conn-1"),
      accountId: AccountId("conn-1"),
    } as unknown as RegisteredSource["instance"],
    ...over,
  } as RegisteredSource;
}

describe("what the gateway is told about how to display a source", () => {
  test("reannounces discovered account identity without deriving it from the display label", () => {
    const account = {
      id: "conn-1",
      label: "Example account",
      subject: { kind: "opaque" as const, value: "subject-1" },
    };
    expect(sourceDisplayMeta(source({ account })).account).toEqual(account);
    expect(sourceDisplayMeta(source()).account).toBeUndefined();
  });
  test("the source's own identity is the instance's when it overrides", () => {
    const meta = sourceDisplayMeta(
      source({
        instance: {
          id: SourceId("example-bank:conn-1"),
          label: "one institution",
        } as unknown as RegisteredSource["instance"],
      }),
    );
    expect(meta.label).toBe("one institution");
    expect(meta.icon).toBe("OWN_ICON");
  });

  test("the family's is the definition's, never the instance's", () => {
    // The whole reason the family is carried: an account that renames itself
    // after its institution must not rename the family.
    const meta = sourceDisplayMeta(
      source({
        instance: {
          id: SourceId("example-bank:conn-1"),
          label: "one institution",
        } as unknown as RegisteredSource["instance"],
        icon: { sfSymbol: "banknote", color: "#ddd", url: "INSTITUTION_LOGO" },
      }),
    );
    expect(meta.family).toEqual({
      label: "Accounts",
      icon: "FAMILY_ICON",
      bgColor: "#111",
      accentColor: "#eee",
    });
  });

  test("an embedded icon is carried when there is no url", () => {
    const meta = sourceDisplayMeta(
      source({
        icon: { sfSymbol: "banknote", color: "#ddd", imageDataUri: "data:image/png;base64,AAA" },
        family: {
          name: "Accounts",
          icon: { sfSymbol: "banknote", color: "#eee", imageDataUri: "data:image/png;base64,BBB" },
        },
      }),
    );
    expect(meta.icon).toBe("data:image/png;base64,AAA");
    expect(meta.family?.icon).toBe("data:image/png;base64,BBB");
  });

  test("a source with no icon still declares its family's name", () => {
    const meta = sourceDisplayMeta(source({ icon: undefined, family: { name: "Accounts" } }));
    expect(meta.icon).toBeUndefined();
    expect(meta.family).toEqual({
      label: "Accounts",
      icon: undefined,
      bgColor: undefined,
      accentColor: undefined,
    });
  });
});
