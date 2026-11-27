// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { ReleasedPeerFixture } from "./released-peer-fixture.js";

// Deliberately requires the named isolated phase; missing preparation is not a skipped pass.
test("current collector ingests on the published gateway while desktop protection stays unavailable", async () => {
  const fixture = await ReleasedPeerFixture.create("released-gateway");
  let failure: unknown;
  try {
    const active = await fixture.addPeer("current", {
      name: "Current fixture note",
      text: "cobaltcompasscurrentinitial",
    });
    const sibling = await fixture.addPeer("released", {
      name: "Released sibling note",
      text: "amberbridgesiblinginitial",
    });
    expect(active.deviceId).not.toBe(sibling.deviceId);
    expect(active.sourceId).not.toBe(sibling.sourceId);
    expect(sibling.version).toBe("0.8.1");
    // Initial ingestion must really finish before pause; an in-flight initial page is not pause leakage.
    const activeInitial = await fixture.settled(active);
    await fixture.settled(sibling);
    const activeHits = await fixture.wait(
      () => fixture.search("cobaltcompasscurrentinitial"),
      (items) => items.some((hit) => hit.sourceId === active.sourceId),
      "current-initial-note-searchable",
    );
    const siblingHits = await fixture.wait(
      () => fixture.search("amberbridgesiblinginitial"),
      (items) => items.some((hit) => hit.sourceId === sibling.sourceId),
      "released-sibling-initial-note-searchable",
    );
    const activeId = activeHits.find((hit) => hit.sourceId === active.sourceId)!.documentId;
    const siblingId = siblingHits.find((hit) => hit.sourceId === sibling.sourceId)!.documentId;

    await fixture.pause(active, true);
    await fixture.wait(
      () => fixture.sourceStatus(active),
      (value) => value.state === "paused",
      "current-paused-projection",
    );
    // The real collector must consume pause and refuse to trigger work before the pending note exists.
    const disabled = await fixture.wait(
      () => fixture.sync(active),
      (value) => value.result.disabled === 1 && value.result.triggered === 0,
      "current-pause-command-consumed",
    );
    expect(disabled.result).toMatchObject({ ok: true, triggered: 0, disabled: 1 });
    const siblingBefore = await fixture.sourceStatus(sibling);
    await fixture.note(active, "Paused fixture note", "silverorbitpausedpending");
    await fixture.note(sibling, "Sibling fixture note", "coppermeadowcurrentnext");
    expect((await fixture.sync(active)).result).toMatchObject({ triggered: 0, disabled: 1 });
    await fixture.sync(sibling);
    await fixture.settled(sibling, siblingBefore.lastSyncAt);
    await fixture.wait(
      () => fixture.search("coppermeadowcurrentnext"),
      (items) => items.some((hit) => hit.sourceId === sibling.sourceId),
      "released-sibling-progress-while-current-paused",
    );
    const stillPaused = await fixture.sourceStatus(active);
    expect(stillPaused.state).toBe("paused");
    expect(stillPaused.lastSyncAt).toBe(activeInitial.lastSyncAt);
    expect(
      (await fixture.search("silverorbitpausedpending")).filter(
        (hit) => hit.sourceId === active.sourceId,
      ),
    ).toEqual([]);

    await fixture.pause(active, false);
    await fixture.sync(active);
    await fixture.wait(
      () => fixture.search("silverorbitpausedpending"),
      (items) => items.some((hit) => hit.sourceId === active.sourceId),
      "current-resumed-real-ingestion",
    );
    await fixture.settled(active, activeInitial.lastSyncAt);
    expect(
      (await fixture.search("cobaltcompasscurrentinitial")).find(
        (hit) => hit.sourceId === active.sourceId,
      )?.documentId,
    ).toBe(activeId);
    expect(
      (await fixture.search("amberbridgesiblinginitial")).find(
        (hit) => hit.sourceId === sibling.sourceId,
      )?.documentId,
    ).toBe(siblingId);
    const protection = await fixture.desktopProtectionRefusal();
    expect(protection.outcomes).toEqual(["unavailable", "unavailable"]);
    expect(protection.independentDesktopGrants).toBe(true);
    // Protection observation must not disturb the ordinary collector's real authority.
    expect((await fixture.sync(active)).result.ok).toBe(true);
    expect((await fixture.sourceStatus(active)).state).not.toBe("paused");
    await writeFile(
      "/results/cohort.json",
      JSON.stringify({
        format: 1,
        initialSyncSettled: true,
        independentDeviceIds: true,
        realPublishedGateway: true,
        desktopProtectionUnavailable: true,
        independentDesktopGrants: true,
        fullDesktopCoordinatorQualified: false,
        freshAccountOnboardingQualified: false,
        pauseConsumedBeforeNewFile: true,
        releasedSiblingProgressWhileCurrentPaused: true,
        resumedFileIngested: true,
        stableDocumentIds: true,
        operatingSystems: 1,
        nativePermissionsQualified: false,
        reverseOrdinaryCollectorQualified: true,
      }),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    failure = await fixture.recordFailure(error);
  }
  try {
    await fixture.close();
  } catch (cleanupFailure) {
    const evidenceFailure = await fixture.recordFailure(cleanupFailure, "close-failed");
    throw Object.assign(
      new AggregateError(
        [...(failure ? [failure] : []), evidenceFailure],
        "Released cohort cleanup unconfirmed",
        { cause: failure ?? cleanupFailure },
      ),
      { cleanupFailure },
    );
  }
  if (failure) throw failure;
}, 900000);
