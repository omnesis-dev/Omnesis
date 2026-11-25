// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { acquireGatewayLock } from "@omnesis/core";
import { desktopProfile } from "./environment.js";
import { desktopComponentOwner, withDesktopComponentOwnership } from "./component-process.js";
import { previewDesktopRemoval, removeDesktopInstall } from "./removal.js";

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-component-")));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
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
  await writeFile(
    join(profile.configDir, "desktop-install.json"),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      mode: "home",
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

describe.skipIf(process.platform === "win32")("managed component ownership", () => {
  test("a lifetime lease prevents removal after the supervisor listener has disappeared", async () => {
    const profile = await fixture();
    const ready = deferred(),
      exit = deferred();
    const component = withDesktopComponentOwnership(profile, "collector", async () => {
      ready.resolve();
      await exit.promise;
    });
    await ready.promise;
    try {
      const plan = await previewDesktopRemoval(profile, {
        eraseData: true,
        signal: new AbortController().signal,
      });
      await expect(
        removeDesktopInstall(
          profile,
          {
            eraseData: true,
            confirmationId: plan.confirmationId!,
            signal: new AbortController().signal,
          },
          {
            stopDaemon: async () => false,
            purge: async () => {
              throw new Error("A live collector's key must not be purged");
            },
          },
        ),
      ).rejects.toThrow();
    } finally {
      exit.resolve();
      await component;
    }
  });

  test("a held ordinary gateway lease also prevents removal", async () => {
    const profile = await fixture();
    const lease = await acquireGatewayLock(profile.configDir, { waitMs: 0 });
    try {
      const plan = await previewDesktopRemoval(profile, {
        eraseData: true,
        signal: new AbortController().signal,
      });
      await expect(
        removeDesktopInstall(
          profile,
          {
            eraseData: true,
            confirmationId: plan.confirmationId!,
            signal: new AbortController().signal,
          },
          {
            stopDaemon: async () => false,
            purge: async () => {
              throw new Error("A live gateway's key must not be purged");
            },
          },
        ),
      ).rejects.toThrow();
    } finally {
      lease.release();
    }
  });

  test("a component that encounters retirement before boot opens no provider stores", async () => {
    const profile = await fixture();
    const plan = await previewDesktopRemoval(profile, { signal: new AbortController().signal });
    await removeDesktopInstall(
      profile,
      { confirmationId: plan.confirmationId!, signal: new AbortController().signal },
      { stopDaemon: async () => false },
    );
    let ran = false;
    await withDesktopComponentOwnership(profile, "collector", async () => {
      ran = true;
    });
    expect(ran).toBe(false);
  });

  test("two concurrent component owners cannot start the same local provider stores", async () => {
    const profile = await fixture();
    const ready = deferred(),
      exit = deferred();
    const first = withDesktopComponentOwnership(profile, "collector", async () => {
      ready.resolve();
      await exit.promise;
    });
    await ready.promise;
    try {
      await expect(
        withDesktopComponentOwnership(profile, "collector", async () => {}),
      ).rejects.toThrow();
    } finally {
      exit.resolve();
      await first;
    }
    const lease = await acquireGatewayLock(desktopComponentOwner(profile, "collector"), {
      waitMs: 0,
    });
    lease.release();
  });

  test("loss of the actual inherited parent channel invokes the child's graceful signal handler", async () => {
    const module = new URL("./parent-lifetime.ts", import.meta.url).href;
    const script = `import { installDesktopParentLifetime } from ${JSON.stringify(module)};
      process.once('SIGTERM', () => { process.stdout.write('graceful-stop\\n'); process.exit(0); });
      installDesktopParentLifetime(); process.send({ ready: true }); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        OMNESIS_CONFIG_DIR: join(home, "fixture-config"),
        OMNESIS_SECRET_STORE: "file",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    let diagnostics = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      diagnostics = (diagnostics + chunk).slice(-4096);
    });
    const exited = once(child, "exit");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        once(child, "message"),
        exited.then(() => {
          throw new Error(`The IPC fixture exited before becoming ready: ${diagnostics}`);
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`The IPC fixture did not become ready: ${diagnostics}`)),
            10_000,
          );
        }),
      ]);
      clearTimeout(timer);
      child.disconnect();
      const result = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`The IPC fixture did not stop: ${diagnostics}`)),
            8_000,
          );
        }),
      ]);
      expect(result[0]).toBe(0);
      expect(output).toContain("graceful-stop");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      child.stdout!.destroy();
      child.stderr!.destroy();
    }
  }, 20_000);
});
