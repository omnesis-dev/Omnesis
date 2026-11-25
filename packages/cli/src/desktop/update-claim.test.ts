// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { desktopProfile } from "./environment.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { desktopRootIdentity, writeDesktopRetirement } from "./retirement.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { createDesktopUpdateSnapshot, desktopUpdateSnapshotPath } from "./update-snapshot.js";
import { claimDesktopUpdateEpoch } from "./update-claim.js";
import {
  readDesktopUpdateState,
  writeDesktopUpdateState,
  type DesktopUpdateState,
} from "./update-state.js";

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-update-claim-")));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
async function fixture() {
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(profile.configDir, "omnesis.db"), "invented-sealed-store", { mode: 0o600 });
  const root = (await desktopRootIdentity(profile))!;
  const operationId = randomUUID();
  let state!: DesktopUpdateState;
  await withDesktopInstallLease(profile, signal(), async () => {
    const leases = await acquireDesktopRuntimeLeases(profile, {
      expectedRoot: root,
      signal: signal(),
    });
    try {
      const backup = await createDesktopUpdateSnapshot(profile, {
        operationId,
        leases,
        signal: signal(),
      });
      state = {
        format: 1,
        owner: "omnesis-desktop",
        instance: profile.instance,
        secretService: profile.secretService,
        operationId,
        phase: "installer-opened",
        mode: "home",
        oldEpoch: "a".repeat(64),
        candidateEpoch: "b".repeat(64),
        oldVersion: "1.2.2",
        candidateVersion: "1.2.3",
        artifactSha256: "c".repeat(64),
        root,
        backup,
      };
      await writeDesktopUpdateState(profile, state);
    } finally {
      leases.release();
    }
  });
  return { profile, state };
}
describe.skipIf(process.platform === "win32")("desktop update runtime admission", () => {
  test("only the exact verified candidate can cross the migration boundary", async () => {
    const { profile, state } = await fixture();
    expect(await claimDesktopUpdateEpoch(profile, signal(), state.oldEpoch)).toBe(false);
    expect((await readDesktopUpdateState(profile))?.phase).toBe("installer-opened");
    expect(await claimDesktopUpdateEpoch(profile, signal(), state.candidateEpoch)).toBe(true);
    expect((await readDesktopUpdateState(profile))?.phase).toBe("candidate-started");
    expect(await claimDesktopUpdateEpoch(profile, signal(), state.oldEpoch)).toBe(false);
    expect(await claimDesktopUpdateEpoch(profile, signal(), state.candidateEpoch)).toBe(true);
    expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(
      "invented-sealed-store",
    );
  });
  test("a missing or corrupted recovery file refuses candidate admission before stores open", async () => {
    const { profile, state } = await fixture();
    await writeFile(
      join(desktopUpdateSnapshotPath(profile, state.operationId), "files/omnesis.db"),
      "corrupt",
    );
    await expect(
      claimDesktopUpdateEpoch(profile, signal(), state.candidateEpoch),
    ).rejects.toThrow();
    expect((await readDesktopUpdateState(profile))?.phase).toBe("installer-opened");
    expect(await readFile(join(profile.configDir, "omnesis.db"), "utf8")).toBe(
      "invented-sealed-store",
    );
  });
  test("retirement takes precedence over an otherwise admitted candidate epoch", async () => {
    const { profile, state } = await fixture();
    await withDesktopInstallLease(profile, signal(), () =>
      writeDesktopRetirement(profile, {
        version: 1,
        owner: "omnesis-desktop",
        instance: profile.instance,
        secretService: profile.secretService,
        operationId: randomUUID(),
        mode: "keep-data",
        phase: "complete",
        root: state.root,
      }),
    );
    expect(await claimDesktopUpdateEpoch(profile, signal(), state.candidateEpoch)).toBe(false);
    expect((await readDesktopUpdateState(profile))?.phase).toBe("installer-opened");
  });
  test("cancellation never records a candidate start", async () => {
    const { profile, state } = await fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(
      claimDesktopUpdateEpoch(profile, abort.signal, state.candidateEpoch),
    ).rejects.toThrow();
    expect((await readDesktopUpdateState(profile))?.phase).toBe("installer-opened");
  });
});
