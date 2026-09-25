// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import * as sourcesApi from "./api.js";

const {
  detachSourceMember,
  enableSourceMultiDeviceMode,
  getAdminSources,
  joinSourceMember,
  updateSourceMemberConfig,
} = sourcesApi;

afterEach(() => vi.unstubAllGlobals());

function respond(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

describe("source membership API wrappers", () => {
  test("enables the descriptor's mode on an existing source", async () => {
    const reply = { source: { id: "notes:local", multiDeviceMode: "partitioned" } };
    const fetchMock = respond(200, reply);
    vi.stubGlobal("fetch", fetchMock);

    await expect(enableSourceMultiDeviceMode("notes:local", "partitioned")).resolves.toEqual(reply);
    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/sources/notes%3Alocal",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ multiDeviceMode: "partitioned" }),
      }),
    );
  });

  test("joins a device to a source", async () => {
    const reply = { source: { id: "notes:local" }, members: ["dev-a", "dev-b"] };
    const fetchMock = respond(200, reply);
    vi.stubGlobal("fetch", fetchMock);

    await expect(joinSourceMember("notes:local", "dev-b")).resolves.toEqual(reply);
    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/sources/notes%3Alocal/members",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ deviceId: "dev-b" }) }),
    );
  });

  test("joins atomically with the addressed member overlay", async () => {
    const reply = { source: { id: "notes:local" }, members: ["dev-a", "dev-b"] };
    const fetchMock = respond(200, reply);
    vi.stubGlobal("fetch", fetchMock);
    const memberConfig = { params: { sessionsPath: "/srv/fictional-beta/sessions" } };

    await joinSourceMember("notes:local", "dev-b", memberConfig);

    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/sources/notes%3Alocal/members",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ deviceId: "dev-b", memberConfig }),
      }),
    );
  });

  test("updates only one existing member overlay", async () => {
    const reply = { source: { id: "notes:local" } };
    const fetchMock = respond(200, reply);
    vi.stubGlobal("fetch", fetchMock);
    const configOverride = { params: { sessionsPath: "/srv/fictional-beta/reconfigured" } };

    await updateSourceMemberConfig("notes:local", "dev-b", configOverride);

    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/sources/notes%3Alocal/members/dev-b",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ configOverride }) }),
    );
  });

  test("detaches a device from a source", async () => {
    const reply = { source: { id: "notes:local" }, members: ["dev-a"] };
    const fetchMock = respond(200, reply);
    vi.stubGlobal("fetch", fetchMock);

    await expect(detachSourceMember("notes:local", "dev-b")).resolves.toEqual(reply);
    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/sources/notes%3Alocal/members/dev-b",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  test("lifts the gateway's refusal code and sentence onto the error", async () => {
    vi.stubGlobal(
      "fetch",
      respond(409, {
        error: "device Maya-Laptop is the last host of notes:local",
        code: "LAST_MEMBER",
      }),
    );

    const err = await detachSourceMember("notes:local", "dev-a").catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 409,
      code: "LAST_MEMBER",
      serverMessage: "device Maya-Laptop is the last host of notes:local",
    });
  });
});

describe("getAdminSources", () => {
  test("passes the gateway's internal-source list through", async () => {
    const reply = {
      items: [],
      pageInfo: { hasMore: false },
      pendingRemovals: [],
      internalSources: [{ id: "omnesis-notes" }],
    };
    vi.stubGlobal("fetch", respond(200, reply));

    await expect(getAdminSources()).resolves.toEqual(reply);
  });

  test("defaults a missing internal-source list to empty", async () => {
    vi.stubGlobal("fetch", respond(200, { items: [] }));

    const result = await getAdminSources();
    expect(result.internalSources).toEqual([]);
    expect(result.pendingRemovals).toEqual([]);
  });
});
