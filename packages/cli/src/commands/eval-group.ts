// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { evalDoctorCommand } from "./eval-doctor.js";
import { evalRunCommand } from "./eval-run.js";
import { evalCompareCommand } from "./eval-compare.js";
import { evalShowCommand } from "./eval-show.js";

export const evalCommand = defineCommand({
  meta: {
    name: "eval",
    description: "Search quality + performance eval toolkit",
  },
  subCommands: {
    doctor: evalDoctorCommand,
    run: evalRunCommand,
    show: evalShowCommand,
    compare: evalCompareCommand,
  },
});
