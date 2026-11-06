// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { planScopeRefresh, isScopeRefreshBookmark } from "./scope-refresh.js";

describe("native refresh cut planning", () => {
  it("rotates a missing cut once, then follows the gateway's replacement without cascading restarts", () => {
    const first = planScopeRefresh(undefined, "required-b", true);
    expect(first.restart).toBe(true);
    expect(first.continueImmediately).toBe(true);
    const deferred = planScopeRefresh(first.bookmark, "required-b", true);
    expect(deferred.restart).toBe(true);
    expect(deferred.continueImmediately).toBe(false);
    expect(deferred.bookmark?.requestId).toBe(first.bookmark?.requestId);
    const unrelated = planScopeRefresh(first.bookmark, "required-c", true);
    expect(unrelated.restart).toBe(true);
    expect(unrelated.bookmark?.requestId).not.toBe(first.bookmark?.requestId);
    const wrongAck = planScopeRefresh(
      first.bookmark,
      "required-c",
      true,
      "holder",
      "00000000-0000-4000-8000-000000000000",
    );
    expect(wrongAck.restart).toBe(true);
    const next = planScopeRefresh(
      first.bookmark,
      "required-c",
      true,
      "holder",
      first.bookmark?.requestId,
    );
    expect(next.scan).toBe(true);
    expect(next.restart).toBe(false);
    const changed = planScopeRefresh(next.bookmark, "required-d", true);
    expect(changed.restart).toBe(true);
  });
  it("members never rotate or release a cut, and acquiring authority starts a fresh cut", () => {
    const member = planScopeRefresh(undefined, "required-b", true, "member");
    expect(member.scan).toBe(true);
    expect(member.controls).toBe(false);
    const holder = planScopeRefresh(
      { ...member.bookmark!, completed: true },
      "required-b",
      true,
      "holder",
    );
    expect(holder.restart).toBe(true);
  });
  it("drops protocol-two progress on an unsupported interval and preserves completed native progress otherwise", () => {
    const bookmark = {
      epoch: "required-b",
      authority: "holder" as const,
      after: "cedar",
      completed: true,
    };
    expect(planScopeRefresh(bookmark, "required-b", false).bookmark).toBeUndefined();
    expect(planScopeRefresh(bookmark, "required-b", true).scan).toBe(false);
    expect(planScopeRefresh(bookmark, "required-b", true).bookmark).toEqual(bookmark);
  });
  it("binds a production cut to its registered actor even when a native store was copied", () => {
    const first = planScopeRefresh(
      undefined,
      "required-b",
      true,
      "holder",
      undefined,
      "collector-a",
    );
    const adopted = planScopeRefresh(
      first.bookmark,
      "required-c",
      true,
      "holder",
      first.bookmark?.requestId,
      "collector-a",
    );
    const peer = planScopeRefresh(
      adopted.bookmark,
      "required-c",
      true,
      "holder",
      first.bookmark?.requestId,
      "collector-b",
    );
    expect(peer.restart).toBe(true);
    expect(peer.bookmark?.actorId).toBe("collector-b");
    const missingActor = planScopeRefresh(
      { epoch: "required-c", authority: "holder", completed: true },
      "required-c",
      true,
      "holder",
      undefined,
      "collector-b",
    );
    expect(missingActor.restart).toBe(true);
  });

  it("validates bounded durable bookmarks", () => {
    expect(
      isScopeRefreshBookmark({ epoch: "required-b", authority: "holder", after: "cedar" }),
    ).toBe(true);
    expect(
      isScopeRefreshBookmark({ epoch: "required-b", authority: "holder", completed: "yes" }),
    ).toBe(false);
    expect(
      isScopeRefreshBookmark({ epoch: "required-b", authority: "holder", after: "x".repeat(513) }),
    ).toBe(false);
  });
});
