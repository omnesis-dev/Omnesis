// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  PERIODIC_DRAIN_ALARM,
  PERMISSION_RECONCILE_ALARM,
  RETRY_DRAIN_ALARM,
} from "./alarm-names.js";

describe("extension alarm identities", () => {
  it("keeps periodic, retry, and permission schedules independent", () => {
    expect(
      new Set([PERIODIC_DRAIN_ALARM, RETRY_DRAIN_ALARM, PERMISSION_RECONCILE_ALARM]).size,
    ).toBe(3);
  });
});
