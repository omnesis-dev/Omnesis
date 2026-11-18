// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { hasStreamCapacity } from "./stream-admission.js";

test.each([1, 2, 3, 4, 16, 256])(
  "capacity %i reserves its final quarter for a new client without exceeding its ceiling",
  (capacity) => {
    const reserve = Math.floor(capacity / 4);
    for (let occupied = 0; occupied <= capacity; occupied++) {
      expect(hasStreamCapacity(capacity, occupied, 0)).toBe(occupied < capacity);
      expect(hasStreamCapacity(capacity, occupied, 1)).toBe(occupied < capacity - reserve);
    }
  },
);
