// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { compareSnapshots, takeSnapshot, waitHealthy } from "./probe.mjs";

function snap(overrides = {}) {
  return {
    takenAt: "2026-01-01T00:00:00.000Z",
    version: "1.0.0",
    uptime: 600,
    docTotal: 3,
    devices: [
      { id: "gw-1", name: "gateway-host", kind: "cli", online: false, version: null },
      { id: "col-1", name: "laptop", kind: "collector", online: true, version: "1.0.0" },
    ],
    services: [
      { component: "gateway", state: "running", pid: 100 },
      { component: "collector", state: "running", pid: 200 },
    ],
    doctorFailures: ["models.embedder"],
    preUpdateBackups: 0,
    search: { query: "brindlewick", titles: ["Harbor lantern checklist"] },
    fleet: null,
    ...overrides,
  };
}

const updated = (overrides = {}) =>
  snap({
    takenAt: "2026-01-01T00:05:00.000Z",
    version: "1.0.1",
    uptime: 20,
    services: [
      { component: "gateway", state: "running", pid: 300 },
      { component: "collector", state: "running", pid: 400 },
    ],
    preUpdateBackups: 1,
    ...overrides,
  });

const expectUpdate = {
  version: "1.0.1",
  restart: ["gateway", "collector"],
  backup: true,
  title: "Harbor lantern checklist",
  fleetCurrent: false,
};

describe("compareSnapshots", () => {
  it("accepts an update that kept every promise", () => {
    expect(compareSnapshots(snap(), updated(), expectUpdate)).toEqual([]);
  });

  it("names every broken promise at once", () => {
    const after = updated({
      version: "1.0.0",
      uptime: 900,
      docTotal: 2,
      devices: [{ id: "col-2", name: "laptop", kind: "collector", online: true, version: "1.0.1" }],
      services: [
        { component: "gateway", state: "running", pid: 100 },
        { component: "collector", state: "failed", pid: null },
      ],
      doctorFailures: ["models.embedder", "service.gateway"],
      preUpdateBackups: 0,
      search: { query: "brindlewick", titles: [] },
    });
    const failures = compareSnapshots(snap(), after, expectUpdate);
    expect(failures).toEqual([
      "gateway serves 1.0.0, expected 1.0.1",
      "gateway was not restarted (still pid 100)",
      "collector is not running under its supervisor (failed)",
      "gateway uptime 900s shows no restart",
      "collector laptop (col-1) is gone or has a new device id",
      "document count changed from 3 to 2",
      'search for "brindlewick" no longer finds "Harbor lantern checklist" (got [])',
      "no new pre-update backup was taken",
      "doctor reports new failures: service.gateway",
    ]);
  });

  it("flags a collector that kept its id but is not connected", () => {
    const after = updated({
      devices: [
        { id: "col-1", name: "laptop", kind: "collector", online: false, version: "1.0.1" },
      ],
    });
    expect(compareSnapshots(snap(), after, expectUpdate)).toEqual([
      "collector laptop is not connected",
    ]);
  });

  it("only requires a restart of the components it names", () => {
    const after = updated({
      services: [
        { component: "gateway", state: "running", pid: 300 },
        { component: "collector", state: "running", pid: 200 },
      ],
    });
    expect(compareSnapshots(snap(), after, { ...expectUpdate, restart: ["gateway"] })).toEqual([]);
  });

  it("requires every fleet device current when asked", () => {
    const fleet = {
      targetVersion: "1.0.1",
      devices: [
        {
          id: "col-1",
          name: "laptop",
          version: "1.0.1",
          disposition: "current",
          updateState: "installed",
        },
        {
          id: "col-9",
          name: "desk",
          version: "1.0.0",
          disposition: "update",
          updateState: "failed",
        },
      ],
    };
    expect(
      compareSnapshots(snap(), updated({ fleet }), { ...expectUpdate, fleetCurrent: true }),
    ).toEqual(["fleet device desk is update on 1.0.0 (update failed)"]);
    expect(compareSnapshots(snap(), updated(), { ...expectUpdate, fleetCurrent: true })).toEqual([
      "no fleet plan was read",
    ]);
  });
});

/** A stand-in gateway that answers the routes the probe reads. */
async function fakeGateway(routes) {
  const server = createServer((req, res) => {
    const route = routes[`${req.method} ${req.url}`];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    if (route.auth && req.headers.authorization !== "Bearer t0k") {
      res.writeHead(401).end();
      return;
    }
    const body = typeof route.body === "function" ? route.body() : route.body;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

describe("gateway reads", () => {
  it("waits for the expected version", async () => {
    let calls = 0;
    const { server, url } = await fakeGateway({
      "GET /health": { body: () => ({ status: "ok", version: ++calls < 3 ? "1.0.0" : "1.0.1" }) },
    });
    try {
      const health = await waitHealthy(url, {
        expectVersion: "1.0.1",
        timeoutMs: 5000,
        intervalMs: 10,
      });
      expect(health.version).toBe("1.0.1");
      await expect(
        waitHealthy(url, { expectVersion: "2.0.0", timeoutMs: 50, intervalMs: 10 }),
      ).rejects.toThrow(/not healthy on 2.0.0: status=ok version=1.0.1/);
    } finally {
      server.close();
    }
  });

  it("builds a snapshot from the API and the CLI's JSON", async () => {
    const { server, url } = await fakeGateway({
      "GET /health": { body: { status: "ok", version: "1.0.1" } },
      "GET /status": { auth: true, body: { uptime: 12, documents: { total: 3 } } },
      "GET /admin/devices": {
        auth: true,
        body: {
          items: [
            { id: "col-1", name: "laptop", kind: "collector", online: true, version: "1.0.1" },
            { id: "old", name: "gone", kind: "collector", online: false, revokedAt: 5 },
          ],
        },
      },
      "POST /search": { auth: true, body: { results: [{ title: "Harbor lantern checklist" }] } },
      "GET /admin/fleet/update": {
        auth: true,
        body: {
          targetVersion: "1.0.1",
          devices: [
            { id: "col-1", name: "laptop", version: "1.0.1", disposition: { kind: "current" } },
          ],
        },
      },
    });
    try {
      const s = await takeSnapshot({
        url,
        token: "t0k",
        query: "brindlewick",
        services: { items: [{ component: "gateway", state: "running", pid: 7 }] },
        doctor: {
          checks: [
            { id: "a", status: "fail" },
            { id: "b", status: "warn" },
          ],
        },
        backups: { backups: [{ purpose: "pre-update" }, { purpose: "manual" }] },
        fleet: true,
      });
      expect(s).toMatchObject({
        version: "1.0.1",
        uptime: 12,
        docTotal: 3,
        devices: [
          { id: "col-1", name: "laptop", kind: "collector", online: true, version: "1.0.1" },
        ],
        services: [{ component: "gateway", state: "running", pid: 7 }],
        doctorFailures: ["a"],
        preUpdateBackups: 1,
        search: { query: "brindlewick", titles: ["Harbor lantern checklist"] },
        fleet: {
          targetVersion: "1.0.1",
          devices: [
            {
              id: "col-1",
              name: "laptop",
              version: "1.0.1",
              disposition: "current",
              updateState: null,
            },
          ],
        },
      });
    } finally {
      server.close();
    }
  });
});
