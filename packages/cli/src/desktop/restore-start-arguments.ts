// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  desktopRestoreActivationSchema,
  type DesktopRestoreActivation,
} from "./restore-activation.js";
export type { DesktopRestoreActivation } from "./restore-activation.js";

/** Internal, operation-bound argv; never accepted from an inherited environment variable. */
export function desktopRestoreActivationArguments(
  authorization?: DesktopRestoreActivation,
): string[] {
  return authorization
    ? ["--restore-start", JSON.stringify(desktopRestoreActivationSchema.parse(authorization))]
    : [];
}

export function readDesktopRestoreActivationArguments(
  args: string[],
): DesktopRestoreActivation | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--restore-start" || args[1]!.length > 1024)
    throw new Error("Invalid managed restore startup authorization");
  try {
    return desktopRestoreActivationSchema.parse(JSON.parse(args[1]!));
  } catch {
    throw new Error("Invalid managed restore startup authorization");
  }
}
