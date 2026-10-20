// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ToolResult } from "@omnesis/core";
import type { ToolContext, ToolHandle } from "./backend.js";

/** Invoke a registry handle at the common model boundary; the handle owns schema validation. */
export async function invokeToolHandle(
  handle: ToolHandle,
  args: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await handle.invoke(args, context);
  } catch (error) {
    return {
      kind: "error",
      code: "tool_threw",
      message: error instanceof Error ? error.message : "tool threw",
    };
  }
}
