// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

/**
 * A result-count argument capped at `max`. Models regularly ask for more rows
 * than a tool returns even though the schema they are shown says the maximum;
 * rejecting that wastes a whole model round on an error, so a larger request
 * reads as the maximum. Anything else invalid is still refused.
 */
export function cappedLimit(max: number) {
  return z.preprocess(
    (value) => (typeof value === "number" && Number.isInteger(value) && value > max ? max : value),
    z.number().int().min(1).max(max),
  );
}
