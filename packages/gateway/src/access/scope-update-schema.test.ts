// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { documentScopeFactsSchema } from "./scope-update-schema.js";

test.each([{}, { label: "cut" }, { participant: "roster", folder: "tree" }])(
  "accepts only the native refresh kinds a producer actually observed: %j",
  (refreshEpochs) => {
    expect(
      documentScopeFactsSchema.parse({ facts: [], complete: [], refreshEpochs }).refreshEpochs,
    ).toEqual(refreshEpochs);
  },
);
test.each([{ futureKind: "cut" }, { label: "" }, { label: 2 }, { label: "x".repeat(129) }])(
  "rejects invalid native refresh proofs: %j",
  (refreshEpochs) => {
    expect(
      documentScopeFactsSchema.safeParse({ facts: [], complete: [], refreshEpochs }).success,
    ).toBe(false);
  },
);
