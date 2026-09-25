// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { DeviceId } from "@omnesis/types";
import { BadGatewayError, ValidationError } from "../../errors.js";
import { WsCommandError, type DeviceWsServer } from "../../../ws.js";
import { wsProxy } from "./internals.js";
import type { Context } from "hono";

describe("wsProxy", () => {
  const c = { json: (body: unknown) => Response.json(body) } as unknown as Context;
  const relay = (error: Error) =>
    wsProxy(
      c,
      undefined,
      async () => DeviceId("5b0c8f64-2a3e-4d7b-9c1e-0f6a2b3c4d5e"),
      {} as DeviceWsServer,
      async () => {
        throw error;
      },
    );

  test("a device refusing the input answers the caller with a 400 in the device's words", async () => {
    // The fix is in what was sent, so a bad-gateway answer sent the operator
    // looking at a device that was working.
    const refusal = relay(
      new WsCommandError("invalid_input", 'shelf-notes: unknown setting "colour"'),
    );
    await expect(refusal).rejects.toBeInstanceOf(ValidationError);
    await expect(refusal).rejects.toMatchObject({
      status: 400,
      message: 'shelf-notes: unknown setting "colour"',
    });
  });

  test("a device failing to carry out the command is still a bad gateway", async () => {
    await expect(
      relay(new WsCommandError("handler_error", "disk unavailable")),
    ).rejects.toBeInstanceOf(BadGatewayError);
  });
});
