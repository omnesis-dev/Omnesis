// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  gatewayCandidates,
  isGatewayDeviceName,
  requestJoin,
  type JoinTransport,
} from "./tailscale-join.js";

const status = (peers: Record<string, unknown>, backend = "Running") =>
  JSON.stringify({ BackendState: backend, Self: { UserID: 7 }, Peer: peers });

describe("isGatewayDeviceName", () => {
  test("matches the device name and Tailscale's numbered variants only", () => {
    for (const name of ["omnesis", "omnesis-1", "Omnesis-12"])
      expect(isGatewayDeviceName(name), name).toBe(true);
    for (const name of ["omnesisx", "my-omnesis", "omnesis-a", ""])
      expect(isGatewayDeviceName(name), name).toBe(false);
    expect(isGatewayDeviceName("home-box-2", "home-box")).toBe(true);
    expect(isGatewayDeviceName("home.box", "home.box")).toBe(true);
    expect(isGatewayDeviceName("homexbox", "home.box")).toBe(false);
  });
});

describe("gatewayCandidates", () => {
  test("prefers the owner's own online gateway, then other online ones", () => {
    const tailnet = gatewayCandidates(
      status({
        a: { DNSName: "omnesis-1.example-net.ts.net.", Online: true, UserID: 8 },
        b: { DNSName: "omnesis.example-net.ts.net.", Online: true, UserID: 7 },
        c: { DNSName: "omnesis-2.example-net.ts.net.", Online: false, UserID: 7 },
        d: { DNSName: "maya-laptop.example-net.ts.net.", Online: true, UserID: 7 },
        e: {
          DNSName: "omnesis-3.example-net.ts.net.",
          Online: true,
          UserID: 7,
          Tags: ["tag:server"],
        },
      }),
    );
    expect(tailnet.running).toBe(true);
    expect(tailnet.candidates).toEqual([
      { dnsName: "omnesis.example-net.ts.net", online: true, sameOwner: true },
      { dnsName: "omnesis-2.example-net.ts.net", online: false, sameOwner: true },
      { dnsName: "omnesis-1.example-net.ts.net", online: true, sameOwner: false },
      { dnsName: "omnesis-3.example-net.ts.net", online: true, sameOwner: false },
    ]);
  });

  test("a machine whose Tailscale is not connected, or whose output is garbage, has none", () => {
    expect(
      gatewayCandidates(status({ a: { DNSName: "omnesis.x.ts.net." } }, "NeedsLogin")),
    ).toEqual({
      running: false,
      candidates: [],
    });
    expect(gatewayCandidates("not json")).toEqual({ running: false, candidates: [] });
    expect(gatewayCandidates(JSON.stringify({ BackendState: "Running" }))).toEqual({
      running: true,
      candidates: [],
    });
  });
});

function transport(answers: Array<{ status: number; json: unknown }>) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const t: JoinTransport = {
    post: vi.fn((path: string, body: unknown) => {
      calls.push({ path, body });
      const next = answers.shift();
      if (!next) return Promise.reject(new Error("no more answers"));
      return Promise.resolve(next);
    }),
  };
  return { t, calls };
}

const joined = {
  status: 200,
  json: {
    status: "joined",
    device: { id: "d1", name: "maya-laptop", kind: "collector" },
    tokenId: "t1",
    token: "tok",
    scopes: ["read"],
  },
};

describe("requestJoin", () => {
  test("an automatic join answers at once", async () => {
    const { t, calls } = transport([joined]);
    const answer = await requestJoin({
      transport: t,
      name: "maya-laptop",
      capabilities: { platform: "linux" },
    });
    expect(answer).toMatchObject({ status: "joined", token: "tok" });
    expect(calls).toEqual([
      {
        path: "/tailscale/join",
        body: { name: "maya-laptop", capabilities: { platform: "linux" } },
      },
    ]);
  });

  test("a held request is polled with its secret until approved, tolerating rate limits", async () => {
    const pending = {
      status: 202,
      json: {
        status: "pending",
        requestId: "r/1",
        secret: "s3cret-s3cret-s3",
        expiresAt: "2026-11-14T18:10:00Z",
      },
    };
    const { t, calls } = transport([
      pending,
      { status: 202, json: { status: "pending" } },
      { status: 429, json: {} },
      joined,
    ]);
    const onWaiting = vi.fn();
    const answer = await requestJoin({
      transport: t,
      name: "x",
      capabilities: {},
      onWaiting,
      sleep: async () => {},
    });
    expect(answer.status).toBe("joined");
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(calls.slice(1).every((c) => c.path === "/tailscale/join/r%2F1/poll")).toBe(true);
    expect(calls[1]!.body).toEqual({ secret: "s3cret-s3cret-s3" });
  });

  test("an answer that is not a well-formed join is never taken for one", async () => {
    for (const json of [
      { status: "joined", device: { id: "d1", name: "x", kind: "collector" }, scopes: [] },
      {
        status: "joined",
        device: { id: "d1", name: "x", kind: "ios" },
        tokenId: "t",
        token: "k",
        scopes: [],
      },
      "<html>not json</html>",
    ]) {
      const answer = await requestJoin({
        transport: transport([{ status: 200, json }]).t,
        name: "x",
        capabilities: {},
      });
      expect(answer.status).toBe("refused");
    }
  });

  test("refusals, denials and expiry carry the gateway's words", async () => {
    expect(
      await requestJoin({
        transport: transport([
          { status: 403, json: { code: "not-owner", error: "Only the owner." } },
        ]).t,
        name: "x",
        capabilities: {},
      }),
    ).toEqual({ status: "refused", code: "not-owner", error: "Only the owner." });
    const pending = {
      status: 202,
      json: { status: "pending", requestId: "r", secret: "s", expiresAt: "" },
    };
    expect(
      await requestJoin({
        transport: transport([
          pending,
          { status: 403, json: { status: "denied", error: "Denied." } },
        ]).t,
        name: "x",
        capabilities: {},
        sleep: async () => {},
      }),
    ).toEqual({ status: "denied", error: "Denied." });
    let clock = 0;
    const timedOut = await requestJoin({
      transport: transport([pending, { status: 202, json: { status: "pending" } }]).t,
      name: "x",
      capabilities: {},
      sleep: () => {
        clock += 60_000;
        return Promise.resolve();
      },
      now: () => clock,
      deadlineMs: 30_000,
    });
    expect(timedOut.status).toBe("gone");
    expect(
      await requestJoin({
        transport: transport([{ status: 500, json: "oops" }]).t,
        name: "x",
        capabilities: {},
      }),
    ).toEqual({ status: "refused", error: "The gateway answered 500." });
  });
});
