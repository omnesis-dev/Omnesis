// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { indexRebuildCommand } from "./index-rebuild.js";

export const indexCommand = defineCommand({
  meta: { name: "index", description: "Global index operations (admin)" },
  subCommands: {
    rebuild: indexRebuildCommand,
  },
});
