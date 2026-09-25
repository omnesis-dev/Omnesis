// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { sourcesListCommand } from "./sources.js";
import { addCommand } from "./add.js";
import { removeCommand } from "./remove.js";
import { moveSourceCommand } from "./move.js";
import { membersCommand } from "./members.js";
import { joinSourceCommand } from "./join.js";
import { detachSourceCommand } from "./detach.js";
import { pauseSourceCommand } from "./pause.js";
import { resumeSourceCommand } from "./resume.js";
import { syncCommand } from "./sync.js";
import { resyncCommand } from "./resync.js";
import { reauthCommand } from "./reauth.js";
import { debugCommand } from "./debug.js";
import { reindexMissingCommand } from "./reindex-missing.js";
import { importHistoryCommand } from "./import-history.js";

export const sourcesCommand = defineCommand({
  meta: {
    name: "sources",
    description: "Manage data sources (admin scope)",
  },
  // Default to the listing when no subcommand is given.
  // See #99 — planned: a command to change a connected source's settings.
  subCommands: {
    list: sourcesListCommand,
    add: addCommand,
    remove: removeCommand,
    move: moveSourceCommand,
    members: membersCommand,
    join: joinSourceCommand,
    detach: detachSourceCommand,
    pause: pauseSourceCommand,
    resume: resumeSourceCommand,
    sync: syncCommand,
    resync: resyncCommand,
    reauth: reauthCommand,
    debug: debugCommand,
    "reindex-missing": reindexMissingCommand,
    "import-history": importHistoryCommand,
  },
  // When no subcommand: behave like `sources list` (preserves existing UX).
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(sourcesListCommand, { rawArgs: [] });
    }
  },
});
