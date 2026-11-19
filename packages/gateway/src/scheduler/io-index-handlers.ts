// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { STORAGE_INDEX_READS } from "../storage/reads.js";
import { ioReadHandlers } from "./read-port.js";
/** These reads own a separate read-only index handle, never the live indexer. */
export const ioIndexHandlers = ioReadHandlers(STORAGE_INDEX_READS);
export type IoIndexHandlers = typeof ioIndexHandlers;
