// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountId, SCOPE_ADMIN, SCOPE_READ, SourceType } from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import {
  addSourceMember,
  createSource,
  getSource,
  getSourceMemberConfigOverride,
  isSourceMember,
} from "../../../data/repositories/SourceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import { createServer } from "../../../server.js";
import { directWriteGate } from "../../../write-gate.js";
import type { DeviceWsServer } from "../../../ws.js";

type Db = ReturnType<typeof createDatabase>;

let db: Db;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let adminToken: string;
let sendCommand: ReturnType<typeof vi.fn>;
let isConnected: ReturnType<typeof vi.fn>;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-member-config-http-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  const cli = createDevice(db, { name: "Fictional CLI", kind: "cli" });
  adminToken = createToken(db, cli.id, [SCOPE_ADMIN, SCOPE_READ]).token;
  sendCommand = vi.fn(async (_deviceId: string, type: string) => {
    if (type === "source.descriptors") {
      return {
        descriptors: [{ id: "visits-synth", hasDiscover: false }],
        hostname: "fictional-host.example.com",
      };
    }
    return { ok: true };
  });
  isConnected = vi.fn(() => true);
  app = createServer(db, dbPath, {
    writeGate: directWriteGate(db),
    wsServer: {
      sendCommand,
      isConnected,
    } as unknown as DeviceWsServer,
  });
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("POST /admin/sources/resolve-account", () => {
  test("forwards local params to the selected collector and returns its identity", async () => {
    const collector = createDevice(db, {
      name: "Fictional collector",
      kind: "collector",
      capabilities: { hostableSourceTypes: [SourceType("visits-synth")] },
    });
    sendCommand.mockImplementation(async (_deviceId: string, type: string) =>
      type === "source.resolve-account" ? { accountId: "vault-123" } : { ok: true },
    );
    const response = await app.request("/admin/sources/resolve-account", {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: collector.id,
        descriptorId: "visits-synth",
        params: { vaultPath: "/tmp/fictional-vault" },
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ accountId: "vault-123" });
    expect(sendCommand).toHaveBeenCalledWith(
      collector.id,
      "source.resolve-account",
      { descriptorId: "visits-synth", params: { vaultPath: "/tmp/fictional-vault" } },
      10_000,
    );
  });
});

describe("PATCH /admin/sources/:id/members/:deviceId", () => {
  function partitionedPair() {
    const capabilities = {
      hostableSourceTypes: [SourceType("visits-synth")],
      multiDeviceModes: { "visits-synth": "partitioned" as const },
      memberScopedParams: { "visits-synth": ["sessionsPath"] },
      syncLease: true,
    };
    const owner = createDevice(db, {
      name: "Fictional owner",
      kind: "collector",
      capabilities,
    });
    const member = createDevice(db, {
      name: "Fictional member",
      kind: "collector",
      capabilities,
    });
    const source = createSource(db, {
      type: SourceType("visits-synth"),
      accountId: AccountId("fictional-account"),
      deviceId: owner.id,
      multiDeviceMode: "partitioned",
      config: { syncInterval: "5m" },
    });
    addSourceMember(db, source.id, member.id);
    return { owner, member, source };
  }

  test("POST joins with its member overlay atomically and notifies only that effective path", async () => {
    const { member, source } = partitionedPair();
    db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
      source.id,
      member.id,
    );
    const response = await app.request(`/admin/sources/${encodeURIComponent(source.id)}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: member.id,
        memberConfig: { params: { sessionsPath: "/srv/fictional-member/sessions" } },
      }),
    });

    expect(response.status).toBe(200);
    expect(getSource(db, source.id)?.config).toEqual({ syncInterval: "5m" });
    expect(getSourceMemberConfigOverride(db, source.id, member.id)).toEqual({
      params: { sessionsPath: "/srv/fictional-member/sessions" },
    });
    await vi.waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith(member.id, "source.added", {
        source: expect.objectContaining({
          id: source.id,
          config: {
            syncInterval: "5m",
            params: { sessionsPath: "/srv/fictional-member/sessions" },
          },
        }),
      });
    });
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  test("POST refuses a discovered-account mismatch before adding the member", async () => {
    const { member, source } = partitionedPair();
    db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
      source.id,
      member.id,
    );
    sendCommand.mockImplementation(async (_deviceId: string, type: string) => {
      if (type === "source.descriptors") {
        return {
          descriptors: [{ id: "visits-synth", hasDiscover: true }],
          hostname: "fictional-host.example.com",
        };
      }
      if (type === "source.discover") return { accounts: ["another-account"] };
      return { ok: true };
    });

    const response = await app.request(`/admin/sources/${encodeURIComponent(source.id)}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: member.id }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "SOURCE_ACCOUNT_NOT_AVAILABLE_ON_DEVICE",
      error: expect.stringContaining("does not have the account configured"),
    });
    expect(isSourceMember(db, source.id, member.id)).toBe(false);
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  test("POST joins when descriptor discovery finds the source account", async () => {
    const { member, source } = partitionedPair();
    db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
      source.id,
      member.id,
    );
    sendCommand.mockImplementation(async (_deviceId: string, type: string) => {
      if (type === "source.descriptors") {
        return {
          descriptors: [{ id: "visits-synth", hasDiscover: true }],
          hostname: "fictional-host.example.com",
        };
      }
      if (type === "source.discover") return { accounts: ["fictional-account"] };
      return { ok: true };
    });

    const response = await app.request(`/admin/sources/${encodeURIComponent(source.id)}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: member.id }),
    });

    expect(response.status).toBe(200);
    expect(isSourceMember(db, source.id, member.id)).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith(
      member.id,
      "source.discover",
      { descriptorId: "visits-synth" },
      30_000,
    );
  });

  test("POST accepts a validated member-local availability path outside discovery", async () => {
    const { member, source } = partitionedPair();
    db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
      source.id,
      member.id,
    );
    sendCommand.mockImplementation(async (_deviceId: string, type: string) => {
      if (type === "source.descriptors") {
        return {
          descriptors: [
            {
              id: "visits-synth",
              hasDiscover: true,
              params: [
                {
                  name: "sessionsPath",
                  label: "Sessions path",
                  type: "path",
                  scope: "member",
                  provesLocalAvailabilityForAccount: "fictional-account",
                },
              ],
            },
          ],
          hostname: "fictional-host.example.com",
        };
      }
      if (type === "source.validate-param") return { valid: true };
      if (type === "source.discover") return { accounts: [] };
      return { ok: true };
    });

    const response = await app.request(`/admin/sources/${encodeURIComponent(source.id)}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: member.id,
        memberConfig: { params: { sessionsPath: "/srv/fictional-member/sessions" } },
      }),
    });

    expect(response.status).toBe(200);
    expect(isSourceMember(db, source.id, member.id)).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith(
      member.id,
      "source.validate-param",
      {
        descriptorId: "visits-synth",
        paramName: "sessionsPath",
        value: "/srv/fictional-member/sessions",
      },
      10_000,
    );
    expect(sendCommand).not.toHaveBeenCalledWith(
      member.id,
      "source.discover",
      expect.anything(),
      expect.anything(),
    );
  });

  test("POST validates every supplied availability path before joining", async () => {
    const { member, source } = partitionedPair();
    db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
      source.id,
      member.id,
    );
    sendCommand.mockImplementation(
      async (_deviceId: string, type: string, payload: Record<string, unknown>) => {
        if (type === "source.descriptors") {
          return {
            descriptors: [
              {
                id: "visits-synth",
                hasDiscover: true,
                params: [
                  {
                    name: "sessionsPath",
                    type: "path",
                    scope: "member",
                    provesLocalAvailabilityForAccount: "fictional-account",
                  },
                  {
                    name: "archivePath",
                    type: "path",
                    scope: "member",
                    provesLocalAvailabilityForAccount: "fictional-account",
                  },
                ],
              },
            ],
            hostname: "fictional-host.example.com",
          };
        }
        if (type === "source.validate-param") {
          return payload.paramName === "sessionsPath"
            ? { valid: true }
            : { valid: false, error: "Archive path is unavailable" };
        }
        if (type === "source.discover") return { accounts: ["fictional-account"] };
        return { ok: true };
      },
    );

    const response = await app.request(`/admin/sources/${encodeURIComponent(source.id)}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: member.id,
        memberConfig: {
          params: {
            sessionsPath: "/srv/fictional-member/sessions",
            archivePath: "/srv/fictional-member/archive",
          },
        },
      }),
    });

    expect(response.status).toBe(409);
    expect(isSourceMember(db, source.id, member.id)).toBe(false);
    expect(sendCommand).not.toHaveBeenCalledWith(
      member.id,
      "source.discover",
      expect.anything(),
      expect.anything(),
    );
  });

  test("POST ignores malformed descriptor params and falls back to discovery", async () => {
    const { member, source } = partitionedPair();
    db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
      source.id,
      member.id,
    );
    sendCommand.mockImplementation(async (_deviceId: string, type: string) => {
      if (type === "source.descriptors") {
        return {
          descriptors: [
            {
              id: "visits-synth",
              hasDiscover: true,
              params: [
                null,
                1,
                {
                  name: "sessionsPath",
                  type: "path",
                  scope: "member",
                  required: "true",
                  provesLocalAvailabilityForAccount: "fictional-account",
                },
              ],
            },
          ],
          hostname: "fictional-host.example.com",
        };
      }
      if (type === "source.discover") return { accounts: ["fictional-account"] };
      return { ok: true };
    });

    const response = await app.request(`/admin/sources/${encodeURIComponent(source.id)}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: member.id,
        memberConfig: { params: { sessionsPath: "/srv/fictional-member/sessions" } },
      }),
    });

    expect(response.status).toBe(200);
    expect(isSourceMember(db, source.id, member.id)).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith(
      member.id,
      "source.discover",
      { descriptorId: "visits-synth" },
      30_000,
    );
  });

  test("POST leaves membership untouched when account discovery fails", async () => {
    const { member, source } = partitionedPair();
    db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
      source.id,
      member.id,
    );
    sendCommand.mockImplementation(async (_deviceId: string, type: string) => {
      if (type === "source.descriptors") {
        return {
          descriptors: [{ id: "visits-synth", hasDiscover: true }],
          hostname: "fictional-host.example.com",
        };
      }
      if (type === "source.discover") throw new Error("fictional discovery failure");
      return { ok: true };
    });

    const response = await app.request(`/admin/sources/${encodeURIComponent(source.id)}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: member.id }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "BAD_GATEWAY",
      error: expect.stringContaining("Could not check the accounts available"),
    });
    expect(isSourceMember(db, source.id, member.id)).toBe(false);
  });

  test("POST leaves membership untouched when descriptor inspection fails", async () => {
    const { member, source } = partitionedPair();
    db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
      source.id,
      member.id,
    );
    sendCommand.mockRejectedValue(new Error("fictional collector failure"));

    const response = await app.request(`/admin/sources/${encodeURIComponent(source.id)}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: member.id }),
    });

    expect(response.status).toBe(502);
    expect(isSourceMember(db, source.id, member.id)).toBe(false);
  });

  test("POST rejects a missing or malformed advertised descriptor before membership changes", async () => {
    const { member, source } = partitionedPair();
    db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
      source.id,
      member.id,
    );
    sendCommand.mockResolvedValue({
      descriptors: [null, { id: "visits-synth" }, { hasDiscover: true }],
      hostname: "fictional-host.example.com",
    });

    const response = await app.request(`/admin/sources/${encodeURIComponent(source.id)}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: member.id }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "SOURCE_TYPE_NOT_AVAILABLE_ON_DEVICE",
    });
    expect(isSourceMember(db, source.id, member.id)).toBe(false);
  });

  test("POST defers discovery for an offline collector and preserves the existing join contract", async () => {
    const { member, source } = partitionedPair();
    db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
      source.id,
      member.id,
    );
    isConnected.mockReturnValue(false);

    const response = await app.request(`/admin/sources/${encodeURIComponent(source.id)}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: member.id }),
    });

    expect(response.status).toBe(200);
    expect(isSourceMember(db, source.id, member.id)).toBe(true);
    expect(sendCommand).not.toHaveBeenCalledWith(
      member.id,
      "source.descriptors",
      expect.anything(),
      expect.anything(),
    );
  });

  test("stores a member overlay and returns only that member's effective config", async () => {
    const { member, source } = partitionedPair();

    const response = await app.request(
      `/admin/sources/${encodeURIComponent(source.id)}/members/${member.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          configOverride: { params: { sessionsPath: "/srv/example/sessions" } },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: {
        id: source.id,
        config: {
          syncInterval: "5m",
          params: { sessionsPath: "/srv/example/sessions" },
        },
      },
    });
    expect(getSource(db, source.id)?.config).toEqual({ syncInterval: "5m" });
    expect(getSourceMemberConfigOverride(db, source.id, member.id)).toEqual({
      params: { sessionsPath: "/srv/example/sessions" },
    });
    await vi.waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith(member.id, "source.updated", {
        source: expect.objectContaining({
          id: source.id,
          config: {
            syncInterval: "5m",
            params: { sessionsPath: "/srv/example/sessions" },
          },
        }),
      });
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["top-level setting", { syncInterval: "1m" }],
    ["undeclared parameter", { params: { sharedPath: "/srv/example/shared" } }],
    ["non-object params", { params: "/srv/example/sessions" }],
    ["structured parameter value", { params: { sessionsPath: ["/srv/example/sessions"] } }],
  ])("rejects %s without changing the member row", async (_label, configOverride) => {
    const { member, source } = partitionedPair();
    const response = await app.request(
      `/admin/sources/${encodeURIComponent(source.id)}/members/${member.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ configOverride }),
      },
    );

    expect(response.status).toBe(400);
    expect(getSourceMemberConfigOverride(db, source.id, member.id)).toEqual({});
  });

  test("rejects an unauthenticated request, malformed body, and a non-member", async () => {
    const owner = createDevice(db, { name: "Fictional owner", kind: "collector" });
    const outsider = createDevice(db, { name: "Fictional outsider", kind: "collector" });
    const source = createSource(db, {
      type: SourceType("visits-synth"),
      accountId: AccountId("fictional-account"),
      deviceId: owner.id,
      multiDeviceMode: "partitioned",
    });
    const path = `/admin/sources/${encodeURIComponent(source.id)}/members/${outsider.id}`;

    const unauthenticated = await app.request(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configOverride: {} }),
    });
    expect(unauthenticated.status).toBe(401);

    const malformed = await app.request(path, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(malformed.status).toBe(400);

    const nonMember = await app.request(path, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ configOverride: {} }),
    });
    expect(nonMember.status).toBe(409);
  });
});
