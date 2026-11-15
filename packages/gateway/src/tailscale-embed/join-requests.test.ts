// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  JOIN_REQUEST_TTL_MS,
  MAX_WAITING,
  MAX_WAITING_PER_NODE,
  TailscaleJoinRequests,
  type JoinRequestDeps,
  type RedeemResult,
} from "./join-requests.js";
import type { DeviceId, Scope, TokenId } from "@omnesis/types";
import type { TailnetPeer } from "./caller.js";

const owner = (nodeId = "nMaya", nodeName = "maya-laptop.example-net.ts.net"): TailnetPeer => ({
  nodeId,
  nodeName,
  os: "macOS",
  userId: "7",
  login: "maya@example.com",
  sameOwner: true,
});

const joined = (name: string): RedeemResult => ({
  outcome: "paired-device",
  credentials: {
    device: { id: `dev-${name}` as DeviceId, name, kind: "collector" },
    tokenId: `tok-${name}` as TokenId,
    token: `secret-token-${name}`,
    scopes: ["read", "write:*"] as Scope[],
  },
});

type Admit = JoinRequestDeps["admit"];

function setup(admit?: Admit, revoked: Record<string, number> = {}) {
  let now = 1_000_000;
  const deps = {
    admit: vi.fn<Admit>(
      admit ?? ((input) => Promise.resolve(joined(String(input.capabilities.suggestedName)))),
    ),
    revokedAt: vi.fn((identity: string) => revoked[identity] ?? null),
    notifyWaiting: vi.fn(),
    notifyJoined: vi.fn(),
    now: () => now,
  };
  return {
    joins: new TailscaleJoinRequests(deps),
    deps,
    advance: (ms: number) => (now += ms),
    revoke: (identity: string) => (revoked[identity] = now),
  };
}

describe("who may ask", () => {
  test("anyone but the owner's own untagged device is refused", async () => {
    const { joins, deps } = setup();
    for (const peer of [
      undefined,
      { ...owner(), sameOwner: false, userId: "8", login: "jamie@example.com" },
      { ...owner(), sameOwner: false, tags: ["tag:server"] },
    ]) {
      const out = await joins.request({ peer, policy: "automatic", name: "x", capabilities: {} });
      expect(out).toMatchObject({ status: "refused", code: "not-owner" });
    }
    expect(deps.admit).not.toHaveBeenCalled();
  });

  test("joining off refuses even the owner", async () => {
    const { joins, deps } = setup();
    const out = await joins.request({
      peer: owner(),
      policy: "off",
      name: "maya-laptop",
      capabilities: {},
    });
    expect(out).toMatchObject({ status: "refused", code: "joining-off" });
    expect(deps.admit).not.toHaveBeenCalled();
  });
});

describe("automatic", () => {
  test("admits at once and tells the owner", async () => {
    const { joins, deps } = setup();
    const out = await joins.request({
      peer: owner(),
      policy: "automatic",
      name: "maya-laptop",
      capabilities: { platform: "darwin" },
    });
    expect(out).toMatchObject({
      status: "joined",
      credentials: { token: "secret-token-maya-laptop" },
    });
    expect(deps.admit).toHaveBeenCalledWith({
      identity: "tailscale-node:nMaya",
      approved: false,
      capabilities: { platform: "darwin", suggestedName: "maya-laptop" },
    });
    expect(deps.notifyJoined).toHaveBeenCalledWith({
      id: "dev-maya-laptop",
      name: "maya-laptop",
      kind: "collector",
    });
    expect(joins.list()).toEqual([]);
  });

  test("a machine without a name of its own joins under its machine name", async () => {
    const { joins, deps } = setup();
    await joins.request({ peer: owner(), policy: "automatic", capabilities: {} });
    expect(deps.admit).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: { suggestedName: "maya-laptop" } }),
    );
  });

  test("a machine whose device the owner revoked waits for approval instead", async () => {
    const { joins, deps } = setup(undefined, { "tailscale-node:nMaya": 1 });
    const out = await joins.request({ peer: owner(), policy: "automatic", capabilities: {} });
    expect(out.status).toBe("pending");
    expect(deps.admit).not.toHaveBeenCalled();
    expect(deps.notifyWaiting).toHaveBeenCalledTimes(1);
    if (out.status !== "pending") throw new Error("expected pending");
    joins.decide(out.requestId, true);
    await joins.poll({ id: out.requestId, secret: out.secret, peer: owner() });
    expect(deps.admit).toHaveBeenCalledWith(
      expect.objectContaining({ identity: "tailscale-node:nMaya", approved: true }),
    );
  });

  test("a failed admission is reported and nobody is notified", async () => {
    const { joins, deps } = setup(() =>
      Promise.resolve({ outcome: "failed", error: "name conflict" }),
    );
    const out = await joins.request({
      peer: owner(),
      policy: "automatic",
      name: "x",
      capabilities: {},
    });
    expect(out).toEqual({ status: "refused", code: "join-failed", message: "name conflict" });
    expect(deps.notifyJoined).not.toHaveBeenCalled();
  });
});

describe("ask first", () => {
  test("holds the request, lists it and notifies, and creates nothing", async () => {
    const { joins, deps } = setup();
    const out = await joins.request({
      peer: owner(),
      policy: "ask",
      name: "maya-laptop",
      capabilities: {},
    });
    expect(out.status).toBe("pending");
    expect(deps.admit).not.toHaveBeenCalled();
    const [view] = joins.list();
    expect(view).toMatchObject({
      name: "maya-laptop",
      machine: "maya-laptop",
      login: "maya@example.com",
      kind: "collector",
      os: "macOS",
    });
    expect(deps.notifyWaiting).toHaveBeenCalledWith(view);
    expect(JSON.stringify(view)).not.toContain(out.status === "pending" ? out.secret : "?");
  });

  test("approval is redeemed on the collector's next poll, exactly once", async () => {
    const { joins, deps } = setup();
    const out = await joins.request({
      peer: owner(),
      policy: "ask",
      name: "maya-laptop",
      capabilities: {},
    });
    if (out.status !== "pending") throw new Error("expected pending");
    const poll = () => joins.poll({ id: out.requestId, secret: out.secret, peer: owner() });
    expect(await poll()).toMatchObject({ status: "pending" });
    expect(joins.decide(out.requestId, true)).toBe(true);
    expect(joins.decide(out.requestId, true)).toBe(false);
    expect(joins.list()).toEqual([]);
    const [first, second] = await Promise.all([poll(), poll()]);
    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(["gone", "joined"]);
    expect(deps.admit).toHaveBeenCalledTimes(1);
    expect(await poll()).toEqual({ status: "gone" });
  });

  test("denial ends the request", async () => {
    const { joins, deps } = setup();
    const out = await joins.request({
      peer: owner(),
      policy: "ask",
      name: "maya-laptop",
      capabilities: {},
    });
    if (out.status !== "pending") throw new Error("expected pending");
    expect(joins.decide(out.requestId, false)).toBe(true);
    expect(await joins.poll({ id: out.requestId, secret: out.secret, peer: owner() })).toEqual({
      status: "denied",
    });
    expect(await joins.poll({ id: out.requestId, secret: out.secret, peer: owner() })).toEqual({
      status: "gone",
    });
    expect(deps.admit).not.toHaveBeenCalled();
  });

  test("only the asking device holding the secret can collect", async () => {
    const { joins, deps } = setup();
    const out = await joins.request({
      peer: owner(),
      policy: "ask",
      name: "maya-laptop",
      capabilities: {},
    });
    if (out.status !== "pending") throw new Error("expected pending");
    joins.decide(out.requestId, true);
    expect(await joins.poll({ id: out.requestId, secret: "x".repeat(43), peer: owner() })).toEqual({
      status: "gone",
    });
    expect(
      await joins.poll({ id: out.requestId, secret: out.secret, peer: owner("nOther") }),
    ).toEqual({ status: "gone" });
    expect(await joins.poll({ id: out.requestId, secret: out.secret, peer: undefined })).toEqual({
      status: "gone",
    });
    expect(deps.admit).not.toHaveBeenCalled();
    expect(
      await joins.poll({ id: out.requestId, secret: out.secret, peer: owner() }),
    ).toMatchObject({ status: "joined" });
  });

  test("an approval the owner overtook by removing the machine's device no longer counts", async () => {
    const { joins, deps, advance, revoke } = setup();
    const out = await joins.request({ peer: owner(), policy: "ask", capabilities: {} });
    if (out.status !== "pending") throw new Error("expected pending");
    joins.decide(out.requestId, true);
    advance(1000);
    revoke("tailscale-node:nMaya");
    expect(await joins.poll({ id: out.requestId, secret: out.secret, peer: owner() })).toEqual({
      status: "denied",
    });
    expect(deps.admit).not.toHaveBeenCalled();
  });

  test("an admission that throws is reported as a failure, not cached as an error", async () => {
    const { joins } = setup(() => Promise.reject(new Error("writer closed")));
    const out = await joins.request({ peer: owner(), policy: "ask", capabilities: {} });
    if (out.status !== "pending") throw new Error("expected pending");
    joins.decide(out.requestId, true);
    expect(await joins.poll({ id: out.requestId, secret: out.secret, peer: owner() })).toEqual({
      status: "failed",
      message: "The gateway could not admit this collector: writer closed",
    });
    const auto = await joins.request({ peer: owner(), policy: "automatic", capabilities: {} });
    expect(auto).toMatchObject({ status: "refused", code: "join-failed" });
  });

  test("a failed redemption after approval is reported once", async () => {
    const { joins } = setup(() => Promise.resolve({ outcome: "failed", error: "name conflict" }));
    const out = await joins.request({ peer: owner(), policy: "ask", name: "x", capabilities: {} });
    if (out.status !== "pending") throw new Error("expected pending");
    joins.decide(out.requestId, true);
    expect(await joins.poll({ id: out.requestId, secret: out.secret, peer: owner() })).toEqual({
      status: "failed",
      message: "name conflict",
    });
    expect(await joins.poll({ id: out.requestId, secret: out.secret, peer: owner() })).toEqual({
      status: "gone",
    });
  });

  test("requests expire after ten minutes", async () => {
    const { joins, advance } = setup();
    const out = await joins.request({ peer: owner(), policy: "ask", name: "x", capabilities: {} });
    if (out.status !== "pending") throw new Error("expected pending");
    advance(JOIN_REQUEST_TTL_MS + 1);
    expect(joins.list()).toEqual([]);
    expect(joins.decide(out.requestId, true)).toBe(false);
    expect(await joins.poll({ id: out.requestId, secret: out.secret, peer: owner() })).toEqual({
      status: "gone",
    });
  });

  test("one device cannot flood the owner, nor can many", async () => {
    const { joins } = setup();
    for (let i = 0; i < MAX_WAITING_PER_NODE; i++) {
      expect(
        (await joins.request({ peer: owner(), policy: "ask", name: `x${i}`, capabilities: {} }))
          .status,
      ).toBe("pending");
    }
    expect(
      await joins.request({ peer: owner(), policy: "ask", name: "again", capabilities: {} }),
    ).toMatchObject({
      status: "refused",
      code: "too-many-requests",
    });
    for (let i = 0; joins.list().length < MAX_WAITING; i++) {
      await joins.request({
        peer: owner(`n${i}`, `machine-${i}`),
        policy: "ask",
        name: `m${i}`,
        capabilities: {},
      });
    }
    expect(
      await joins.request({
        peer: owner("nLast", "last"),
        policy: "ask",
        name: "last",
        capabilities: {},
      }),
    ).toMatchObject({ status: "refused", code: "too-many-requests" });
  });
});
