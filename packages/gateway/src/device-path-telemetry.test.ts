// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, test } from "vitest";
import { DevicePathTelemetry } from "./device-path-telemetry.js";
import type { DeviceId } from "@omnesis/types";
const id = "device-one" as DeviceId;
test("observations stay attached to authenticated sessions and simultaneous sessions preserve their own paths", () => {
  const telemetry = new DevicePathTelemetry();
  const a = {},
    b = {},
    unknown = {};
  telemetry.update(unknown, id, "local");
  telemetry.close(unknown, id);
  expect(telemetry.snapshot(id)).toBeUndefined();
  telemetry.open(a, id, "relay");
  telemetry.open(b, id, "local");
  expect(telemetry.snapshot(id)).toBe("local");
  telemetry.update(unknown, id, "relay");
  telemetry.close(unknown, id);
  expect(telemetry.snapshot(id)).toBe("local");
  telemetry.update(a, id, "relay");
  expect(telemetry.snapshot(id)).toBe("relay");
  telemetry.close(a, id);
  expect(telemetry.snapshot(id)).toBe("local");
  telemetry.close(b, id);
  expect(telemetry.snapshot(id)).toBe("reconnecting");
});
test("legacy sessions never acquire invented route observations and reconnect clears the old grace state", () => {
  const telemetry = new DevicePathTelemetry();
  const socket = {};
  telemetry.open(socket, id);
  expect(telemetry.snapshot(id)).toBeUndefined();
  telemetry.close(socket, id);
  expect(telemetry.snapshot(id)).toBeUndefined();
  telemetry.open(socket, id, "relay");
  telemetry.close(socket, id);
  telemetry.open(socket, id);
  expect(telemetry.snapshot(id)).toBeUndefined();
});
test("disconnected path status expires and its cache remains bounded", () => {
  let now = 0;
  const telemetry = new DevicePathTelemetry(() => now);
  const socket = {};
  telemetry.open(socket, id, "local");
  telemetry.close(socket, id);
  now = 30000;
  expect(telemetry.snapshot(id)).toBeUndefined();
  expect(telemetry.snapshot(id)).toBeUndefined();
  for (let i = 0; i < 1001; i++) {
    const device = `device-${i}` as DeviceId;
    telemetry.open(socket, device, "relay");
    telemetry.close(socket, device);
  }
  expect(telemetry.snapshot("device-0" as DeviceId)).toBeUndefined();
  expect(telemetry.snapshot("device-1000" as DeviceId)).toBe("reconnecting");
});

test("short-lived CLI HTTP observations expire and never override live WS or reconnect presence", () => {
  let now = 0;
  const telemetry = new DevicePathTelemetry(() => now);
  const socket = {};
  telemetry.request(id, "local");
  expect(telemetry.snapshot(id)).toBe("local");
  telemetry.request(id, "relay");
  expect(telemetry.snapshot(id)).toBe("relay");
  telemetry.open(socket, id, "local");
  telemetry.request(id, "relay");
  expect(telemetry.snapshot(id)).toBe("local");
  telemetry.close(socket, id);
  expect(telemetry.snapshot(id)).toBe("reconnecting");
  now = 30000;
  expect(telemetry.snapshot(id)).toBeUndefined();
  expect(telemetry.snapshot(id)).toBeUndefined();
  telemetry.request(id, "local");
  now = 60000;
  expect(telemetry.snapshot(id)).toBeUndefined();
  for (let i = 0; i < 1001; i++) telemetry.request(`request-${i}` as DeviceId, "relay");
  expect(telemetry.snapshot("request-0" as DeviceId)).toBeUndefined();
  expect(telemetry.snapshot("request-1000" as DeviceId)).toBe("relay");
});
