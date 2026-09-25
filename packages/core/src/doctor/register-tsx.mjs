// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Source-mode Worker threads need the tsx ESM hooks explicitly registered so
// `.js` specifiers in TypeScript source resolve to their `.ts` counterparts.
import { register } from "tsx/esm/api";

register();
