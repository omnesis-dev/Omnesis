// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["*.test.ts"], maxWorkers: 1 } });
