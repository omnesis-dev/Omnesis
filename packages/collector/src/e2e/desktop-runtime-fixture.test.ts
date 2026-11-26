// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createDesktopNodeAdapter } from "./desktop-node-adapter.js";
import { installDesktopAccountBridge } from "./desktop-account-bridge.js";
import {
  DesktopRuntimeFixture,
  desktopKeychainFixtureProgram,
  desktopFixturePurgeProgram,
  desktopFixtureRetirementFailure,
} from "./desktop-runtime-fixture.js";
const execute = promisify(execFile);

test("generated OS-keyring fixture parses and models isolated services, atomic insertion and locked reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnesis-desktop-keyring-script-"));
  try {
    await mkdir(join(root, "keychain"));
    const script = join(root, "security.cjs");
    await writeFile(script, desktopKeychainFixtureProgram(root), { mode: 0o700 });
    await execute(process.execPath, ["--check", script]);
    const command = (...args: string[]) => execute(process.execPath, [script, ...args]);
    await command(
      "add-generic-password",
      "-s",
      "fixture-service-a",
      "-a",
      "fixture-account",
      "-w",
      "fixture first value",
    );
    await command(
      "add-generic-password",
      "-s",
      "fixture-service-b",
      "-a",
      "fixture-account",
      "-w",
      "fixture second value",
    );
    expect(
      (await command("find-generic-password", "-s", "fixture-service-a", "-a", "fixture-account"))
        .stdout,
    ).toBe("fixture first value\n");
    expect(
      (await command("find-generic-password", "-s", "fixture-service-b", "-a", "fixture-account"))
        .stdout,
    ).toBe("fixture second value\n");
    await expect(
      command(
        "add-generic-password",
        "-s",
        "fixture-service-a",
        "-a",
        "fixture-account",
        "-w",
        "fixture forbidden overwrite",
      ),
    ).rejects.toMatchObject({ code: 45 });
    await writeFile(join(root, "keychain-locked"), "locked");
    await expect(
      command("find-generic-password", "-s", "fixture-service-a", "-a", "fixture-account"),
    ).rejects.toMatchObject({ code: 36 });
    expect((await command("-h")).stdout).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source runtime adapter fixes system trust for unmodified executable-path descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnesis-desktop-node-policy-"));
  try {
    const adapter = await createDesktopNodeAdapter(root);
    const { stdout } = await execute(adapter, [
      "--input-type=module",
      "-e",
      `
      import {execFileSync} from 'node:child_process';
      if (!process.execArgv.includes('--use-system-ca')) process.exit(2);
      process.stdout.write(execFileSync(process.execPath, ['-p', "JSON.stringify({system:process.execArgv.includes('--use-system-ca'),path:process.execPath})"], {encoding:'utf8'}));
    `,
    ]);
    expect(JSON.parse(stdout)).toEqual({ system: true, path: adapter });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "the source bridge keeps an unclaimed profile empty and runs the real welcome protocol",
  async () => {
    const fixture = await DesktopRuntimeFixture.create({
      prepareInstall: false,
      systemTrustRuntime: true,
      relayUrl: "https://relay.example.test",
    });
    try {
      expect(await readdir(fixture.profile.configDir)).toEqual([]);
      await installDesktopAccountBridge(fixture, {});
      expect(await fixture.command("status")).toMatchObject({ phase: "welcome" });
      expect(await readdir(fixture.profile.configDir)).toEqual([]);
    } finally {
      await fixture.close();
    }
  },
  30_000,
);

// This adapter never runs a real OS credential executable, including on macOS.
test.each(["success", "locked", "denied", "noop", "root-denied", "root-noop"] as const)(
  "owned fixture purger executes actual scoped Codex/root/mirror checks: %s",
  async (fault) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-desktop-purge-adapter-")));
    try {
      await mkdir(join(root, "tools"), { mode: 0o700 });
      await mkdir(join(root, "keychain"), { mode: 0o700 });
      await mkdir(join(root, "home"), { mode: 0o700 });
      await writeFile(join(root, "tools/security"), desktopKeychainFixtureProgram(root), {
        mode: 0o700,
      });
      const profileModule = new URL("../../../cli/src/desktop/environment.ts", import.meta.url)
        .href;
      const program = `
        const {desktopProfile}=await import(${JSON.stringify(profileModule)});
        const profile=desktopProfile(${JSON.stringify(join(root, "home"))});
        ${desktopFixturePurgeProgram(root)}
        await fixtureFs.mkdir(profile.configDir,{recursive:true,mode:0o700});
        const options={backend:'macos-keychain',configDir:profile.configDir,service:profile.secretService,runCommand:fixtureRun};
        const store=fixtureCore.createSecretStore(options);
        await store.write(fixtureCore.OMNESIS_INSTALL_ROOT_KEY,fixtureCore.generateInstallRootKey());
        for(const kind of ['storage-encryption','secret-files'])await store.write(fixtureCore.secureMarkerStateKeyName(kind,profile.configDir),'fixture required marker');
        const codex=fixtureCore.createSecretStore({...options,service:fixtureCore.CODEX_KEYRING_SERVICE});
        for(const home of [fixtureCore.codexPaths(profile.configDir,profile.instance).home,fixtureCore.codexPaths(profile.configDir).home])
          await codex.write(fixtureCore.codexKeyringAccount(home),'fixture credential');
        const unrelated=fixtureCore.createSecretStore({...options,service:'fixture-unrelated-service'});
        await unrelated.write('fixture-account','fixture preserved');
        await fixtureFs.rm(profile.configDir,{recursive:true,force:false});
        const fault=${JSON.stringify(fault)},root=${JSON.stringify(root)};
        const flag={locked:'keychain-locked',denied:'keychain-delete-denied',noop:'keychain-delete-noop','root-denied':'keychain-denied-service','root-noop':'keychain-noop-service'}[fault];
        if(flag)await fixtureFs.writeFile(root+'/'+flag,fault.startsWith('root-')?profile.secretService:'fixture fault',{mode:0o600});
        let outcome;
        try {
          const result=await fixturePurge(profile);
          outcome={markersCleared:result.markersCleared,rootKey:result.rootKey};
        }catch{outcome={refused:true}}
        if(fault==='locked')await fixtureFs.rm(root+'/keychain-locked');
        const preserved=(await unrelated.read('fixture-account'))==='fixture preserved';
        const count=(await fixtureFs.readdir(root+'/keychain')).length;
        const dataStillAbsent=await fixtureFs.lstat(profile.configDir).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error});
        process.stdout.write(JSON.stringify({outcome,preserved,count,dataStillAbsent}));
      `;
      const { stdout } = await execute(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", program],
        {
          cwd: process.cwd(),
          timeout: 20_000,
          maxBuffer: 64 * 1024,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => !key.startsWith("OMNESIS_") && key !== "NODE_OPTIONS",
              ),
            ),
            HOME: join(root, "home"),
            USERPROFILE: join(root, "home"),
          },
        },
      );
      const result = JSON.parse(stdout);
      expect(result.preserved).toBe(true);
      expect(result.dataStillAbsent).toBe(true);
      if (fault === "success") {
        expect(result.outcome).toEqual({ markersCleared: true, rootKey: "deleted" });
        expect(result.count).toBe(1);
      } else if (fault.startsWith("root-")) {
        expect(result.outcome).toEqual({ markersCleared: false, rootKey: "kept" });
        expect(result.count).toBe(4);
      } else {
        expect(result.outcome).toEqual({ refused: true });
        expect(result.count).toBe(6);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("fixture retirement diagnostics report only known outcomes, never unexpected response values", () => {
  expect(
    desktopFixtureRetirementFailure({
      status: "key-cleanup-pending",
      data: "erased",
      keyring: "pending",
    }).message,
  ).toBe("Fixture retirement incomplete: reason=KEY_CLEANUP_PENDING,data=erased,keyring=pending");
  const message = desktopFixtureRetirementFailure({
    status: "fixture-private-status",
    data: "fixture-private-value",
    keyring: "fixture-private-key",
  }).message;
  expect(message).not.toContain("fixture-private");
  expect(message).toContain("data=unknown,keyring=unknown");
});
