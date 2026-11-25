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
      async run() {
        const { retireDesktopApplication } = await import("../desktop/application-retirement.js");
        await retireDesktopApplication(desktopProfile(), AbortSignal.timeout(80_000));
      },
    }),
    daemon: defineCommand({
      meta: {
        name: "daemon",
        description: "Supervise only this native application's owned processes",
      },
      args: {
        "restore-start": { type: "string", description: "Internal restore activation record" },
      },
      async run({ args }) {
        const { runDesktopDaemon } = await import("../desktop/daemon.js");
        const { readDesktopRestoreActivationArguments } =
          await import("../desktop/restore-start-arguments.js");
        const restoreActivation = readDesktopRestoreActivationArguments(
          args["restore-start"] === undefined ? [] : ["--restore-start", args["restore-start"]],
        );
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once("SIGINT", abort);
        process.once("SIGTERM", abort);
        try {
          await runDesktopDaemon(desktopProfile(), {
            signal: controller.signal,
            restoreActivation,
          });
        } finally {
          process.off("SIGINT", abort);
          process.off("SIGTERM", abort);
        }
      },
    }),
  },
});
