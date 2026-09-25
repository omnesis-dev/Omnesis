// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from "vitest";
import { AccountId, SourceType, type DeviceId } from "@omnesis/types";
import { createDatabase } from "./db.js";
import { createDevice } from "./data/repositories/DeviceRepository.js";
import { addSourceMember, createSource } from "./data/repositories/SourceRepository.js";
import { directWriteGate } from "./write-gate.js";
import { createCollectorDeviceResolver } from "./collector-device-resolver.js";
import type { DeviceWsServer } from "./ws.js";

const databases: ReturnType<typeof createDatabase>[] = [];

afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});

function fixture() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const alpha = createDevice(db, {
    name: "collector-alpha",
    kind: "collector",
    capabilities: { hostableSourceTypes: [SourceType("mail-synth")] },
  });
  const beta = createDevice(db, {
    name: "collector-beta",
    kind: "collector",
    capabilities: {
      hostableSourceTypes: [SourceType("mail-synth"), SourceType("calendar-synth")],
    },
  });
  const online = new Set<DeviceId>([alpha.id, beta.id]);
  const source = createSource(db, {
    type: SourceType("mail-synth"),
    accountId: AccountId("maya@example.org"),
    deviceId: alpha.id,
    multiDeviceMode: "replicated",
  });
  expect(addSourceMember(db, source.id, beta.id)).toBe(true);
  const resolver = createCollectorDeviceResolver({
    db,
    wsServer: {
      isConnected: (deviceId: DeviceId) => online.has(deviceId),
    } as DeviceWsServer,
    jsonErr: (status, code, message, extra) =>
      Response.json({ error: message, code, detail: extra }, { status }),
    writeGate: directWriteGate(db),
  });
  return { db, alpha, beta, online, resolver };
}

async function errorBody(result: DeviceId | Response): Promise<Record<string, unknown>> {
  expect(result).toBeInstanceOf(Response);
  return (await (result as Response).json()) as Record<string, unknown>;
}

describe("collector reauth device resolution", () => {
  test("an explicit joined member is a valid device-local auth target", async () => {
    const { beta, resolver } = fixture();

    await expect(
      resolver.resolveCollectorDeviceIdForReauth(beta.id, "maya@example.org"),
    ).resolves.toBe(beta.id);
  });

  test("the owner and joined members form the ambiguity set", async () => {
    const { alpha, beta, resolver } = fixture();

    const result = await resolver.resolveCollectorDeviceIdForReauth(undefined, "maya@example.org");

    expect((result as Response).status).toBe(400);
    await expect(errorBody(result)).resolves.toMatchObject({
      code: "AMBIGUOUS_DEVICE",
      detail: {
        devices: expect.arrayContaining([
          { id: alpha.id, name: alpha.name },
          { id: beta.id, name: beta.name },
        ]),
      },
    });
  });

  test("an online joined member is selected when the owner is offline", async () => {
    const { alpha, beta, online, resolver } = fixture();
    online.delete(alpha.id);

    await expect(
      resolver.resolveCollectorDeviceIdForReauth(undefined, "maya@example.org"),
    ).resolves.toBe(beta.id);
  });

  test("a same-account source of another type cannot validate the requested device", async () => {
    const { db, beta, resolver } = fixture();
    createSource(db, {
      type: SourceType("calendar-synth"),
      accountId: AccountId("jamie@example.org"),
      deviceId: beta.id,
    });
    const resolve = resolver.resolveCollectorDeviceIdForReauth as (
      requested: string | undefined,
      accountId: string,
      sourceType?: string,
    ) => Promise<DeviceId | Response>;

    const result = await resolve(beta.id, "jamie@example.org", "mail-synth");

    await expect(errorBody(result)).resolves.toMatchObject({ code: "NO_MATCHING_SOURCE" });
  });
});
