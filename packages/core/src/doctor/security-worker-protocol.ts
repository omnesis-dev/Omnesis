// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Internal structured-clone contract for the one-shot doctor security worker. */

import type { SecurityData } from "./types.js";

export interface DoctorSecurityWorkerInput {
  configDir: string;
  component: "gateway" | "collector";
}

export type DoctorSecurityWorkerMessage =
  | { type: "done"; security: SecurityData }
  | { type: "error"; error: string };
