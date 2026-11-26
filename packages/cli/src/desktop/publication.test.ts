// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { desktopProfile } from "./environment.js";
import { previewDesktopRemoval, removeDesktopInstall } from "./removal.js";
import { withDesktopPublication, publishDesktopHint } from "./publication.js";

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-publication-")));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await mkdir(`${profile.configDir}.bootstrap`, { recursive: true, mode: 0o700 });
  await writeFile(
    join(`${profile.configDir}.bootstrap`, "process-authority.json"),
    JSON.stringify({
      version: 3,
      owner: "omnesis-desktop",
      instance: profile.instance,
      secretService: profile.secretService,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(profile.configDir, "desktop-install.json"),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      mode: "joined",
      instance: profile.instance,
      secretService: profile.secretService,
      embedder: null,
      memoryLimitMb: 512,
      phase: "configured",
    }),
    { mode: 0o600 },
  );
  return profile;
}

test("retirement waits for an active publication, then refuses stale writes and hints", async () => {
  const profile = await fixture();
  const entered = deferred(),
    release = deferred();
  const publishing = withDesktopPublication(profile, signal(), async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const stop = vi.fn(async () => false);
  const plan = await previewDesktopRemoval(profile, { signal: signal() }, { stopDaemon: stop });
  const removal = removeDesktopInstall(
    profile,
    {
      signal: signal(),
      confirmationId: plan.confirmationId!,
    },
    { stopDaemon: stop },
  );
  expect(stop).not.toHaveBeenCalled();
  release.resolve();
  await publishing;
  await removal;
  const publish = vi.fn(async () => {});
  await expect(withDesktopPublication(profile, signal(), publish)).rejects.toThrow("retired");
  await publishDesktopHint(profile, publish);
  expect(publish).not.toHaveBeenCalled();
});

test("a publication queued behind removal rechecks retirement after taking the external lease", async () => {
  const profile = await fixture();
  const stopped = deferred(),
    drain = deferred();
  const stop = vi.fn(async () => {
    stopped.resolve();
    await drain.promise;
    return false;
  });
  const deps = { stopDaemon: stop };
  const plan = await previewDesktopRemoval(profile, { signal: signal() }, deps);
  const removal = removeDesktopInstall(
    profile,
    {
      signal: signal(),
      confirmationId: plan.confirmationId!,
    },
    deps,
  );
  await stopped.promise;
  const publish = vi.fn(async () => {});
  const pending = withDesktopPublication(profile, signal(), publish);
  const rejected = expect(pending).rejects.toThrow("retired");
  drain.resolve();
  await removal;
  await rejected;
  expect(publish).not.toHaveBeenCalled();
});

test("missing installation cannot publish credentials or optional hints", async () => {
  const profile = desktopProfile(home);
  const publish = vi.fn(async () => {});
  await expect(withDesktopPublication(profile, signal(), publish)).rejects.toThrow("not ready");
  await publishDesktopHint(profile, publish);
  expect(publish).not.toHaveBeenCalled();
});
