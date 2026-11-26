// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { desktopProfile } from "../desktop/environment.js";

export const desktopCommand = defineCommand({
  meta: { name: "desktop", description: "Manage the native desktop application's private runtime" },
  subCommands: {
    bridge: defineCommand({
      meta: {
        name: "bridge",
        description: "Serve the native application's private JSON-line channel",
      },
      async run() {
        const { DesktopCoordinator } = await import("../desktop/coordinator.js");
        const { runDesktopProtocol } = await import("../desktop/protocol.js");
        const coordinator = new DesktopCoordinator(desktopProfile());
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once("SIGINT", abort);
        process.once("SIGTERM", abort);
        try {
          await runDesktopProtocol({
            input: process.stdin,
            output: process.stdout,
            signal: controller.signal,
            handle: (request, context) => coordinator.handle(request, context),
          });
        } finally {
          process.off("SIGINT", abort);
          process.off("SIGTERM", abort);
          await coordinator.close();
        }
      },
    }),
    "system-retire": defineCommand({
      meta: {
        name: "system-retire",
        description: "Keep this application's library stopped after its shell is removed",
      },
      args: {
        "background-owner": {
          type: "boolean",
          default: false,
          description: "Internal native retirement entry",
        },
      },
      async run({ args }) {
        const { runDesktopRetirementEntry } = await import("../desktop/background-retirement.js");
        await runDesktopRetirementEntry(desktopProfile(), {
          backgroundOwner: args["background-owner"] === true,
          signal: AbortSignal.timeout(80_000),
        });
      },
    }),
    daemon: defineCommand({
      meta: {
        name: "daemon",
        description: "Supervise only this native application's owned processes",
      },
      args: {
        "restore-start": { type: "string", description: "Internal restore activation record" },
        "background-owner": {
          type: "boolean",
          default: false,
          description: "Internal native background-owner entry",
        },
      },
      async run({ args }) {
        const { runDesktopDaemonEntry } = await import("../desktop/background-owner.js");
        const { readDesktopRestoreActivationArguments } =
          await import("../desktop/restore-start-arguments.js");
        const restoreActivation = readDesktopRestoreActivationArguments(
          args["restore-start"] === undefined ? [] : ["--restore-start", args["restore-start"]],
        );
        await runDesktopDaemonEntry(desktopProfile(), {
          backgroundOwner: args["background-owner"] === true,
          restoreActivation,
        });
      },
    }),
  },
});
