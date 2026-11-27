// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { ReleasedPeerFixture } from "./released-peer-fixture.js";

// Deliberately requires the named isolated phase; missing preparation is not a skipped pass.
test("published 0.8.1 collector ingests beside a current sibling and pauses independently", async () => {
  const fixture = await ReleasedPeerFixture.create();
  let failure: unknown;
  try {
    const released = await fixture.addPeer("released", {
      name: "Released fixture note",
      text: "cobaltcompassreleaseinitial",
    });
    const current = await fixture.addPeer("current", {
      name: "Current fixture note",
      text: "amberbridgecurrentinitial",
    });
    expect(released.deviceId).not.toBe(current.deviceId);
    expect(released.sourceId).not.toBe(current.sourceId);
    expect(released.version).toBe("0.8.1");
    // Initial ingestion must really finish before pause; an in-flight initial page is not pause leakage.
    const releasedInitial = await fixture.settled(released);
    await fixture.settled(current);
    const oldHits = await fixture.wait(
      () => fixture.search("cobaltcompassreleaseinitial"),
      (items) => items.some((hit) => hit.sourceId === released.sourceId),
      "released-initial-note-searchable",
    );
    const currentHits = await fixture.wait(
      () => fixture.search("amberbridgecurrentinitial"),
      (items) => items.some((hit) => hit.sourceId === current.sourceId),
      "current-initial-note-searchable",
    );
    const oldId = oldHits.find((hit) => hit.sourceId === released.sourceId)!.documentId;
    const currentId = currentHits.find((hit) => hit.sourceId === current.sourceId)!.documentId;

    await fixture.pause(released, true);
    await fixture.wait(
      () => fixture.sourceStatus(released),
      (value) => value.state === "paused",
      "released-paused-projection",
    );
    // The real collector must consume pause and refuse to trigger work before the pending note exists.
    const disabled = await fixture.wait(
      () => fixture.sync(released),
      (value) => value.result.disabled === 1 && value.result.triggered === 0,
      "released-pause-command-consumed",
    );
    expect(disabled.result).toMatchObject({ ok: true, triggered: 0, disabled: 1 });
    const currentBefore = await fixture.sourceStatus(current);
    await fixture.note(released, "Paused fixture note", "silverorbitpausedpending");
    await fixture.note(current, "Sibling fixture note", "coppermeadowcurrentnext");
    expect((await fixture.sync(released)).result).toMatchObject({ triggered: 0, disabled: 1 });
    await fixture.sync(current);
    await fixture.settled(current, currentBefore.lastSyncAt);
    await fixture.wait(
      () => fixture.search("coppermeadowcurrentnext"),
      (items) => items.some((hit) => hit.sourceId === current.sourceId),
      "current-sibling-progress-while-released-paused",
    );
    const stillPaused = await fixture.sourceStatus(released);
    expect(stillPaused.state).toBe("paused");
    expect(stillPaused.lastSyncAt).toBe(releasedInitial.lastSyncAt);
    expect(
      (await fixture.search("silverorbitpausedpending")).filter(
        (hit) => hit.sourceId === released.sourceId,
      ),
    ).toEqual([]);

    await fixture.pause(released, false);
    await fixture.sync(released);
    await fixture.wait(
      () => fixture.search("silverorbitpausedpending"),
      (items) => items.some((hit) => hit.sourceId === released.sourceId),
      "released-resumed-real-ingestion",
    );
    await fixture.settled(released, releasedInitial.lastSyncAt);
    expect(
      (await fixture.search("cobaltcompassreleaseinitial")).find(
        (hit) => hit.sourceId === released.sourceId,
      )?.documentId,
    ).toBe(oldId);
    expect(
      (await fixture.search("amberbridgecurrentinitial")).find(
        (hit) => hit.sourceId === current.sourceId,
      )?.documentId,
    ).toBe(currentId);
    await writeFile(
      "/results/cohort.json",
      JSON.stringify({
        format: 1,
        initialSyncSettled: true,
        independentDeviceIds: true,
        realPublishedCollector: true,
        pauseConsumedBeforeNewFile: true,
        currentProgressWhilePaused: true,
        resumedFileIngested: true,
        stableDocumentIds: true,
        operatingSystems: 1,
        nativePermissionsQualified: false,
        reverseOldGatewayQualified: false,
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
