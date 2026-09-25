// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { DELETE_CHOICE_BODY, deleteConfirmCopy } from "./document-delete.js";

describe("deleteConfirmCopy", () => {
  test("regular sources keep the copy/for-good choice", () => {
    expect(deleteConfirmCopy()).toEqual({
      body: DELETE_CHOICE_BODY,
      confirmLabel: "Delete for good",
      secondaryLabel: "Delete this copy",
    });
  });

  test("the confirm label tracks the in-flight state", () => {
    expect(deleteConfirmCopy({ deleting: true }).confirmLabel).toBe("Deleting…");
  });
});
