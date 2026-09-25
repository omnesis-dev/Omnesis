// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  mayContinuePage,
  sameQuotaBucket,
  widerScope,
  type FailureScope,
} from "./failure-scope.js";

const ALL: FailureScope[] = ["item", "partition", "source", "connection"];

describe("widerScope", () => {
  test("takes the wider of two, in either order", () => {
    expect(widerScope("item", "connection")).toBe("connection");
    expect(widerScope("connection", "item")).toBe("connection");
    expect(widerScope("partition", "source")).toBe("source");
  });

  test("is idempotent", () => {
    for (const scope of ALL) expect(widerScope(scope, scope)).toBe(scope);
  });

  test("combining a page's failures never narrows what it reports", () => {
    // A page that hit one bad item and then lost the connection reports the
    // connection. Reporting the item would let the walk continue against an
    // upstream that is gone.
    const page: FailureScope[] = ["item", "item", "connection", "item"];
    const reported = page.reduce<FailureScope>((acc, s) => widerScope(acc, s), "item");
    expect(reported).toBe("connection");
  });
});

describe("mayContinuePage", () => {
  test("only an item may be stepped over", () => {
    expect(mayContinuePage("item")).toBe(true);
    for (const scope of ALL.filter((s) => s !== "item")) {
      expect(mayContinuePage(scope), `${scope} must stop the page`).toBe(false);
    }
  });
});

describe("sameQuotaBucket", () => {
  test("same kind and id share a budget", () => {
    expect(sameQuotaBucket({ kind: "app", id: "client-1" }, { kind: "app", id: "client-1" })).toBe(
      true,
    );
  });

  test("the same id under different kinds is not the same budget", () => {
    // An account limit and an app limit can carry the same identifier without
    // being the same bucket; treating them as one would back off accounts that
    // were never limited.
    expect(sameQuotaBucket({ kind: "app", id: "x" }, { kind: "account", id: "x" })).toBe(false);
  });

  test("an unknown bucket shares nothing", () => {
    // A failure that does not say what it was counted against cannot be used
    // to back off anything but itself.
    expect(sameQuotaBucket(undefined, { kind: "app", id: "x" })).toBe(false);
    expect(sameQuotaBucket({ kind: "app", id: "x" }, undefined)).toBe(false);
    expect(sameQuotaBucket(undefined, undefined)).toBe(false);
  });
});
