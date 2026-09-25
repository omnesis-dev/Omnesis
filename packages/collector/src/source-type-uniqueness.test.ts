// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Two packages may not claim one source type.
 *
 * Worth a boot failure rather than a warning because of how the duplicate
 * would otherwise present. A source type is the key every registry in the tree
 * looks a descriptor up by, and each of those lookups is first-wins or
 * last-wins over an array ordered by however package loads happened to
 * resolve. So the symptom is not "two sources with the same name" — it is one
 * source's credentials deleted when another is removed, a config key routed to
 * a provider that never wrote it, and a different answer on the next boot.
 */

import { describe, expect, test } from "vitest";
import { assertUniqueSourceTypes } from "./source-descriptors.js";
import type { SourceDescriptor } from "@omnesis/source-sdk";

const descriptor = (id: string, provider: string): SourceDescriptor =>
  ({ id, provider: { id: provider, name: provider } }) as unknown as SourceDescriptor;

describe("a source type has one owner", () => {
  test("distinct types from distinct providers are fine", () => {
    expect(() =>
      assertUniqueSourceTypes([
        descriptor("notes", "vault"),
        descriptor("tasks", "planner"),
        descriptor("messages", "chat"),
      ]),
    ).not.toThrow();
  });

  test("one provider may own several source types", () => {
    // The ordinary case: a platform behind several kinds of data.
    expect(() =>
      assertUniqueSourceTypes([
        descriptor("mail", "acme"),
        descriptor("calendar", "acme"),
        descriptor("files", "acme"),
      ]),
    ).not.toThrow();
  });

  test("two providers claiming one type is refused, and both are named", () => {
    // Naming both is the whole value of the message: the operator has to know
    // which two packages to choose between, and neither is discoverable from
    // the symptom.
    expect(() =>
      assertUniqueSourceTypes([descriptor("notes", "vault"), descriptor("notes", "other-vault")]),
    ).toThrow(/two packages claim the source type "notes".*vault.*other-vault/s);
  });

  test("a package claiming a type twice is refused too", () => {
    // Same provider, same id: still ambiguous to every first-wins lookup.
    expect(() =>
      assertUniqueSourceTypes([descriptor("notes", "vault"), descriptor("notes", "vault")]),
    ).toThrow(/two packages claim the source type/);
  });

  test("an empty registry is not an error here", () => {
    // Booting with nothing loaded is a real failure, and a different guard's.
    expect(() => assertUniqueSourceTypes([])).not.toThrow();
  });
});
