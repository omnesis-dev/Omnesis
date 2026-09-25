// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

// @ts-expect-error — Portal modules are plain JavaScript without sibling declarations.
import { authorizationQrPayload } from "./access-qr-payload.js";

describe("authorization QR payload", () => {
  test("is the deep link the mobile apps open, versioned, with the code as its one parameter", () => {
    expect(authorizationQrPayload("ABCD-EFGH")).toBe(
      "omnesis://access-authorization?v=1&code=ABCD-EFGH",
    );
  });

  test("trims the code as printed and encodes what the link cannot carry bare", () => {
    expect(authorizationQrPayload(" ABCD-EFGH ")).toBe(
      "omnesis://access-authorization?v=1&code=ABCD-EFGH",
    );
    expect(authorizationQrPayload("AB&D EF#H")).toBe(
      "omnesis://access-authorization?v=1&code=AB%26D%20EF%23H",
    );
  });
});
